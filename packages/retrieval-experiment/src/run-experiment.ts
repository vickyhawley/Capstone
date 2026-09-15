/**
 * Sprint 1 retrieval baseline.
 *
 * Runs the 40 golden cases (`evals/datasets/sprint-1/cases.jsonl`)
 * against four retrieval configurations, all with the noop reranker
 * per ADR-0001's control-condition setup and the Sprint 1 brief:
 *
 * 1. dense                — pgvector cosine only
 * 2. sparse               — ts_rank only
 * 3. hybrid-rrf           — dense + sparse, Reciprocal Rank Fusion (k=60)
 * 4. hybrid-weighted      — dense + sparse, weighted min-max (0.5 / 0.5)
 *
 * Metrics per configuration:
 * - recall@5 and recall@10 over the 18 populated-source cases only
 * - nDCG@10 — matches the eval harness's `retrieval_relevance`
 *   (binary relevance, log-position discount). An earlier version
 *   of this file computed precision@k under a "relevance" label,
 *   which mismatched the harness. Fixed 2026-09-15.
 * - latency p50 / p95 (measured in-process, wall-clock per query)
 * - per-slice breakdown by provenance (real / boundary / adversarial)
 *   and by intent
 *
 * Legitimately-empty answer cases (per README §1) are held out of the
 * recall calculations — they score on groundedness and false-refusal
 * only, and counting a miss on them would measure the dataset rather
 * than the retriever.
 *
 * Writes markdown to `evals/results/sprint-1/retrieval-baseline.md`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HybridRetriever,
  PgTsRankRetriever,
  PgvectorDenseRetriever,
  rrf,
  weightedFusion,
} from '@groundwork/adapters';
import type { Retriever } from '@groundwork/core';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// ---------- Types ----------

interface EvalCase {
  readonly id: string;
  readonly intent: string;
  readonly user_input: string;
  readonly expected_behavior: string;
  readonly required_source_ids: readonly string[];
  readonly provenance: string;
  readonly tags: readonly string[];
}

export interface ExperimentConfig {
  readonly name: string;
  readonly retriever: Retriever;
}

interface PerCaseResult {
  readonly caseId: string;
  readonly intent: string;
  readonly provenanceBucket: 'real' | 'boundary' | 'adversarial' | 'other';
  readonly tags: readonly string[];
  readonly requiredSources: readonly string[];
  readonly retrievedIds: readonly string[];
  readonly latencyMs: number;
  readonly error?: string;
}

export interface ExperimentResult {
  readonly configName: string;
  readonly perCase: readonly PerCaseResult[];
}

// ---------- Env ----------

interface Env {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly OPENAI_API_KEY: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

function readEnv(): Env {
  return {
    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  };
}

// ---------- Case loading ----------

function provenanceBucket(provenance: string): PerCaseResult['provenanceBucket'] {
  if (provenance.startsWith('real-customer-enquiry')) return 'real';
  if (provenance.startsWith('constructed-boundary-probe')) return 'boundary';
  if (provenance.startsWith('constructed-adversarial')) return 'adversarial';
  return 'other';
}

function loadCases(path: string): readonly EvalCase[] {
  const raw = readFileSync(path, 'utf-8');
  const cases: EvalCase[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    try {
      cases.push(JSON.parse(trimmed) as EvalCase);
    } catch (error) {
      throw new Error(
        `line ${i + 1}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return cases;
}

// ---------- Experiment ----------

const TOP_K = 10;

export async function runExperiment(
  config: ExperimentConfig,
  cases: readonly EvalCase[],
): Promise<ExperimentResult> {
  const perCase: PerCaseResult[] = [];
  for (const [idx, evalCase] of cases.entries()) {
    process.stderr.write(`  [${idx + 1}/${cases.length}] ${evalCase.id}\r`);
    const t0 = Date.now();
    try {
      const results = await config.retriever.retrieve({
        text: evalCase.user_input,
        topK: TOP_K,
      });
      const latencyMs = Date.now() - t0;
      perCase.push({
        caseId: evalCase.id,
        intent: evalCase.intent,
        provenanceBucket: provenanceBucket(evalCase.provenance),
        tags: evalCase.tags,
        requiredSources: evalCase.required_source_ids,
        retrievedIds: results.map((r) => r.chunkId),
        latencyMs,
      });
    } catch (error) {
      const latencyMs = Date.now() - t0;
      perCase.push({
        caseId: evalCase.id,
        intent: evalCase.intent,
        provenanceBucket: provenanceBucket(evalCase.provenance),
        tags: evalCase.tags,
        requiredSources: evalCase.required_source_ids,
        retrievedIds: [],
        latencyMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stderr.write('\n');
  return { configName: config.name, perCase };
}

// ---------- Metrics ----------

function recallAtK(perCase: readonly PerCaseResult[], k: number): number {
  const scored = perCase.filter((c) => c.requiredSources.length > 0);
  if (scored.length === 0) return 0;
  let hits = 0;
  for (const c of scored) {
    const topK = c.retrievedIds.slice(0, k);
    const found = c.requiredSources.some((id) => topK.includes(id));
    if (found) hits++;
  }
  return hits / scored.length;
}

function dcg(relevances: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < relevances.length; i++) {
    const rel = relevances[i] ?? 0;
    total += rel / Math.log2(i + 2);
  }
  return total;
}

function nDcgAtK(perCase: readonly PerCaseResult[], k: number): number {
  // nDCG@k. Matches evals/groundwork_evals/metrics.py's retrieval_relevance
  // implementation so the same number is comparable between this CLI and
  // the eval harness. Relevances are binary: 1 if the chunk id is in
  // required_source_ids, 0 otherwise. Ideal DCG is the DCG of retrieving
  // min(|required|, k) relevant items in top positions. Cases without
  // required sources are held out (undefined when the target set is empty).
  const scored = perCase.filter((c) => c.requiredSources.length > 0);
  if (scored.length === 0) return 0;
  let total = 0;
  for (const c of scored) {
    const topK = c.retrievedIds.slice(0, k);
    if (topK.length === 0) continue;
    const requiredSet = new Set(c.requiredSources);
    const relevances = topK.map((id) => (requiredSet.has(id) ? 1 : 0));
    const idealCount = Math.min(c.requiredSources.length, k);
    const ideal = dcg(Array(idealCount).fill(1));
    if (ideal === 0) continue;
    total += dcg(relevances) / ideal;
  }
  return total / scored.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] ?? 0;
}

// ---------- Reporting ----------

interface SliceMetrics {
  readonly name: string;
  readonly countTotal: number;
  readonly countScored: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly ndcgAt10: number;
  readonly p50: number;
  readonly p95: number;
}

function computeSlice(name: string, perCase: readonly PerCaseResult[]): SliceMetrics {
  const scored = perCase.filter((c) => c.requiredSources.length > 0);
  return {
    name,
    countTotal: perCase.length,
    countScored: scored.length,
    recallAt5: recallAtK(perCase, 5),
    recallAt10: recallAtK(perCase, 10),
    ndcgAt10: nDcgAtK(perCase, 10),
    p50: percentile(
      perCase.map((c) => c.latencyMs),
      0.5,
    ),
    p95: percentile(
      perCase.map((c) => c.latencyMs),
      0.95,
    ),
  };
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(results: readonly ExperimentResult[]): string {
  const lines: string[] = [];
  lines.push('# Sprint 1 retrieval baseline');
  lines.push('');
  lines.push(`Run at ${new Date().toISOString()}. See `);
  lines.push('`docs/adr/0001-hybrid-retrieval.md#addendum` for interpretation.');
  lines.push('');
  lines.push('Four configurations, all with the noop reranker as the control.');
  lines.push('Reranker treatment is deferred to Sprint 2 per the "leave it as');
  lines.push('the control for now" instruction; addendum applies ADR-0001\'s');
  lines.push('stopping rule accordingly.');
  lines.push('');
  lines.push('## Headline table');
  lines.push('');
  lines.push('| config | recall@5 | recall@10 | nDCG@10 | p50 ms | p95 ms |');
  lines.push(
    '<!-- nDCG@10 matches evals/groundwork_evals/metrics.py `retrieval_relevance` — binary relevance, log-position discount. An earlier version of this report labelled precision@10 as "relevance"; that mismatched the harness. Fixed. -->',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const s = computeSlice('all', r.perCase);
    lines.push(
      `| ${r.configName} | ${formatPct(s.recallAt5)} | ${formatPct(s.recallAt10)} | ${formatPct(s.ndcgAt10)} | ${s.p50} | ${s.p95} |`,
    );
  }
  lines.push('');
  lines.push(
    `Scored over ${
      results[0]?.perCase.filter((c) => c.requiredSources.length > 0).length ?? 0
    } cases with populated source IDs. The 8 legitimately-empty answer cases (§1) and 14 escalate/abstain cases are excluded from recall — they score elsewhere.`,
  );
  lines.push('');
  lines.push('### Hybrid vs dense — the comparison did not happen this sprint');
  lines.push('');
  lines.push(
    "The rows above show hybrid-rrf and hybrid-weighted matching dense-only exactly. That is *not* evidence that fusion adds no value. It is evidence that the sparse component was returning empty on almost every query (see the ts_query AND-semantics finding in ADR-0001's addendum) — 5.6% recall@10 means 1 case in 18 got any sparse hit at all. Hybrid was compared against dense-plus-nothing, not against dense-plus-a-working-sparse-retriever. The Sprint 1 recommendation ships dense-only; the hybrid comparison is deferred to Sprint 2 after `plainto_tsquery` is replaced with `websearch_to_tsquery` or an OR-fallback.",
  );

  // Per-provenance slice
  lines.push('');
  lines.push('## By provenance');
  lines.push('');
  lines.push('| config | slice | scored | recall@5 | recall@10 | nDCG@10 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  const provs: PerCaseResult['provenanceBucket'][] = ['real', 'boundary', 'adversarial'];
  for (const r of results) {
    for (const p of provs) {
      const slice = r.perCase.filter((c) => c.provenanceBucket === p);
      const s = computeSlice(p, slice);
      if (s.countScored === 0) {
        lines.push(`| ${r.configName} | ${p} | 0 | — | — | — |`);
      } else {
        lines.push(
          `| ${r.configName} | ${p} | ${s.countScored} | ${formatPct(s.recallAt5)} | ${formatPct(s.recallAt10)} | ${formatPct(s.ndcgAt10)} |`,
        );
      }
    }
  }

  // Per-intent slice
  lines.push('');
  lines.push('## By intent');
  lines.push('');
  lines.push('| config | intent | scored | recall@5 | recall@10 | nDCG@10 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  const intents = [
    'product',
    'fit',
    'logistics',
    'welfare-clinical',
    'out-of-scope',
    'service-referral',
  ];
  for (const r of results) {
    for (const intent of intents) {
      const slice = r.perCase.filter((c) => c.intent === intent);
      const s = computeSlice(intent, slice);
      if (s.countScored === 0) {
        lines.push(`| ${r.configName} | ${intent} | 0 | — | — | — |`);
      } else {
        lines.push(
          `| ${r.configName} | ${intent} | ${s.countScored} | ${formatPct(s.recallAt5)} | ${formatPct(s.recallAt10)} | ${formatPct(s.ndcgAt10)} |`,
        );
      }
    }
  }

  // Case-level detail for the flagged cases
  lines.push('');
  lines.push('## Flagged cases (per session brief)');
  lines.push('');
  lines.push(
    'These are named in the Job-3 brief as cases whose retrieval outcome is evidence for downstream ADR follow-ups. Report the outcome, do not adjust:',
  );
  lines.push('');
  lines.push(
    '- **Fit gap** (cases 026, 027, 030) — no saddle or girth fit-rule chunks exist. Expected to miss; the miss is the ADR-0003 sprint-2 guide-gap evidence.',
  );
  lines.push(
    '- **Trade synonym** (case 007) — "purple horsehage" ↔ HorseHage Timothy. Nothing in the Timothy listing says "purple"; a miss is ADR-0009 synonym-dictionary follow-up evidence.',
  );
  lines.push('');
  lines.push('| config | case | required | top-5 hit? | top-10 hit? |');
  lines.push('| --- | --- | --- | :---: | :---: |');
  const flagged = [
    'fit-026-cob-wide-back-saddle',
    'fit-027-dressage-girth-line',
    'fit-030-saddle-prompt-injection',
    'product-007-purple-horsehage-price',
  ];
  for (const r of results) {
    for (const caseId of flagged) {
      const c = r.perCase.find((x) => x.caseId === caseId);
      if (!c) continue;
      const req =
        c.requiredSources.length === 0
          ? '(none in corpus)'
          : `${c.requiredSources[0]?.slice(0, 8)}…`;
      const top5 =
        c.requiredSources.length === 0
          ? 'n/a'
          : c.requiredSources.some((id) => c.retrievedIds.slice(0, 5).includes(id))
            ? '✓'
            : '✗';
      const top10 =
        c.requiredSources.length === 0
          ? 'n/a'
          : c.requiredSources.some((id) => c.retrievedIds.slice(0, 10).includes(id))
            ? '✓'
            : '✗';
      lines.push(`| ${r.configName} | ${caseId} | ${req} | ${top5} | ${top10} |`);
    }
  }

  // Errors
  const errors: { config: string; id: string; error: string }[] = [];
  for (const r of results) {
    for (const c of r.perCase) {
      if (c.error) {
        errors.push({ config: r.configName, id: c.caseId, error: c.error });
      }
    }
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push('## Errors');
    lines.push('');
    for (const e of errors) {
      lines.push(`- ${e.config} / ${e.id}: ${e.error}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const env = readEnv();
  const supabase: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const cliDir = resolve(fileURLToPath(import.meta.url), '..');
  const repoRoot = resolve(cliDir, '..', '..', '..');
  const casesPath = resolve(repoRoot, 'evals', 'datasets', 'sprint-1', 'cases.jsonl');
  const outPath = resolve(repoRoot, 'evals', 'results', 'sprint-1', 'retrieval-baseline.md');

  const cases = loadCases(casesPath);
  console.error(`Loaded ${cases.length} cases from ${casesPath}`);

  const dense = new PgvectorDenseRetriever(supabase, openai);
  const sparse = new PgTsRankRetriever(supabase);
  const hybridRrf = new HybridRetriever(dense, sparse, rrf(60));
  const hybridWeighted = new HybridRetriever(dense, sparse, weightedFusion(0.5, 0.5));

  const configs: ExperimentConfig[] = [
    { name: 'dense', retriever: dense },
    { name: 'sparse', retriever: sparse },
    { name: 'hybrid-rrf', retriever: hybridRrf },
    { name: 'hybrid-weighted', retriever: hybridWeighted },
  ];

  const results: ExperimentResult[] = [];
  for (const config of configs) {
    console.error(`\nRunning ${config.name}...`);
    results.push(await runExperiment(config, cases));
  }

  const markdown = renderMarkdown(results);
  writeFileSync(outPath, markdown, 'utf-8');
  console.error(`\nWrote ${outPath}`);

  // Also print headline to stdout
  process.stdout.write(`\n${markdown.split('\n').slice(0, 20).join('\n')}\n`);
}

// Only run main() when executed directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
