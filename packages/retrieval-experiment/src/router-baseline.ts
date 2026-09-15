/**
 * Router baseline measurement. GW-10, Sprint 2, task 5.
 *
 * Runs the HybridRouter against every case in the Sprint 1 golden
 * dataset and reports:
 * - Overall accuracy
 * - Per-intent accuracy (not aggregate — welfare-clinical has n=4 and
 *   disappears into a mean otherwise)
 * - 6×6 confusion matrix, actual rows × predicted columns
 * - The four watched cases called out individually (fit-026, fit-027,
 *   welfare-032, welfare-033) — the fit-vs-welfare boundary is the
 *   specific harm the boundary work exists to prevent
 * - Rule vs LLM split — a rule firing and an LLM inferring are
 *   different kinds of correct
 * - Confidence distribution against correctness — GW-11 needs to know
 *   whether confidence tracks accuracy before it can use confidence
 *   for deferral
 *
 * Explicit non-goal: no prompt tuning, no rules editing, no re-runs
 * to make the number look better. This script produces the number
 * once, honestly, before any adjustment. If the boundary collapses,
 * that is the finding.
 *
 * Package location: `retrieval-experiment` is scoped too narrowly for
 * a router measurement. Follow-up: rename to `@groundwork/experiments`
 * or split into `@groundwork/eval-scripts`. Not doing that in this
 * commit because the naming decision is orthogonal to the measurement
 * and the sprint 2 stop point wants the number first.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HybridRouter } from '@groundwork/adapters';
import { INTENTS, type Intent, type RouterDecision } from '@groundwork/core';
import OpenAI from 'openai';

interface GoldenCase {
  readonly id: string;
  readonly intent: Intent;
  readonly user_input: string;
  readonly expected_behavior: string;
  readonly tags: readonly string[];
}

interface CaseResult {
  readonly case_id: string;
  readonly actual: Intent;
  readonly predicted: Intent;
  readonly correct: boolean;
  readonly confidence: number;
  readonly matched: 'rule' | 'llm';
  readonly rationale: string;
  readonly user_input: string;
  readonly adversarialSuspected: boolean;
  readonly adversarialPattern: string | null;
}

const WATCHED = new Set([
  'fit-026-cob-wide-back-saddle',
  'fit-027-dressage-girth-line',
  'welfare-032-condition-loss-winter',
  'welfare-033-rug-rubbing-withers',
]);

// Cases whose messages carry adversarial content (injection payload,
// jailbreak invocation, role-play override). ADR-0010 amendment 1:
// the router's `adversarialSuspected` should fire on each of these
// regardless of the case's intent label. Cases with adversarial
// intent AND adversarial content overlap here; case 030 is the
// interesting one — labelled `fit` but carries an injection payload.
const ADVERSARIAL_EXPECTED = new Set([
  'fit-030-saddle-prompt-injection',
  'oos-036-prompt-injection',
  'oos-037-role-play-shopbot',
  'oos-038-jailbreak-dan',
]);

// Resolve paths against the repo root, not the CWD. pnpm-filter runs
// the script with CWD = package dir, so a CWD-relative path would
// break under `pnpm --filter`.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATASET_PATH = resolve(REPO_ROOT, 'evals/datasets/sprint-1/cases.jsonl');
const RESULTS_DIR = resolve(REPO_ROOT, 'evals/results/sprint-2');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

function loadCases(path: string): readonly GoldenCase[] {
  const raw = readFileSync(path, 'utf-8');
  const out: GoldenCase[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    out.push(JSON.parse(trimmed) as GoldenCase);
  }
  return out;
}

async function measureOne(router: HybridRouter, c: GoldenCase): Promise<CaseResult> {
  const decision: RouterDecision = await router.route({ text: c.user_input });
  return {
    case_id: c.id,
    actual: c.intent,
    predicted: decision.intent,
    correct: decision.intent === c.intent,
    confidence: decision.confidence,
    matched: decision.matched,
    rationale: decision.rationale,
    user_input: c.user_input,
    adversarialSuspected: decision.adversarialSuspected,
    adversarialPattern: decision.adversarialPattern ?? null,
  };
}

// ---------- Reporting ----------

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function overallAccuracy(results: readonly CaseResult[]): number {
  const correct = results.filter((r) => r.correct).length;
  return correct / results.length;
}

function perIntentAccuracy(
  results: readonly CaseResult[],
): Map<Intent, { correct: number; total: number }> {
  const m = new Map<Intent, { correct: number; total: number }>();
  for (const intent of INTENTS) m.set(intent, { correct: 0, total: 0 });
  for (const r of results) {
    const bucket = m.get(r.actual);
    if (!bucket) continue;
    bucket.total += 1;
    if (r.correct) bucket.correct += 1;
  }
  return m;
}

function confusionMatrix(results: readonly CaseResult[]): Map<Intent, Map<Intent, number>> {
  const matrix = new Map<Intent, Map<Intent, number>>();
  for (const actual of INTENTS) {
    const row = new Map<Intent, number>();
    for (const predicted of INTENTS) row.set(predicted, 0);
    matrix.set(actual, row);
  }
  for (const r of results) {
    const row = matrix.get(r.actual);
    if (!row) continue;
    row.set(r.predicted, (row.get(r.predicted) ?? 0) + 1);
  }
  return matrix;
}

function ruleVsLlm(results: readonly CaseResult[]): {
  rule: { correct: number; total: number };
  llm: { correct: number; total: number };
} {
  const stats = {
    rule: { correct: 0, total: 0 },
    llm: { correct: 0, total: 0 },
  };
  for (const r of results) {
    const bucket = r.matched === 'rule' ? stats.rule : stats.llm;
    bucket.total += 1;
    if (r.correct) bucket.correct += 1;
  }
  return stats;
}

function confidenceCalibration(
  results: readonly CaseResult[],
): Array<{ band: string; n: number; correct: number; accuracy: number }> {
  const bands = [
    { label: '[0.00, 0.50)', lo: 0.0, hi: 0.5 },
    { label: '[0.50, 0.70)', lo: 0.5, hi: 0.7 },
    { label: '[0.70, 0.90)', lo: 0.7, hi: 0.9 },
    { label: '[0.90, 1.00]', lo: 0.9, hi: 1.01 },
  ];
  return bands.map((b) => {
    const inBand = results.filter((r) => r.confidence >= b.lo && r.confidence < b.hi);
    const correct = inBand.filter((r) => r.correct).length;
    return {
      band: b.label,
      n: inBand.length,
      correct,
      accuracy: inBand.length === 0 ? 0 : correct / inBand.length,
    };
  });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ---------- Report formatting ----------

function renderReport(results: readonly CaseResult[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push('# Router baseline — GW-10, Sprint 2');
  lines.push('');
  lines.push(`Run at ${generatedAt}.`);
  lines.push('');
  lines.push('Measures the current router shape (ADR-0010, including');
  lines.push('post-baseline amendments). Reruns overwrite this file;');
  lines.push('the JSON sibling file at `router-baseline-<timestamp>.json`');
  lines.push('is kept per-run so historical diffs are recoverable.');
  lines.push('');
  lines.push(`Cases: ${results.length}. Overall accuracy: **${pct(overallAccuracy(results))}**.`);
  lines.push('');

  // Per-intent
  lines.push('## Per-intent accuracy');
  lines.push('');
  lines.push('| intent | correct | total | accuracy |');
  lines.push('| --- | ---: | ---: | ---: |');
  const perIntent = perIntentAccuracy(results);
  for (const intent of INTENTS) {
    const b = perIntent.get(intent);
    if (!b) continue;
    const acc = b.total === 0 ? '—' : pct(b.correct / b.total);
    lines.push(`| \`${intent}\` | ${b.correct} | ${b.total} | ${acc} |`);
  }
  lines.push('');

  // Confusion matrix
  lines.push('## Confusion matrix (actual rows × predicted columns)');
  lines.push('');
  const header = ['actual \\ predicted', ...INTENTS.map((i) => i)];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  const matrix = confusionMatrix(results);
  for (const actual of INTENTS) {
    const row = matrix.get(actual);
    if (!row) continue;
    const cells = INTENTS.map((predicted) => {
      const v = row.get(predicted) ?? 0;
      // Emphasise the diagonal
      return actual === predicted && v > 0 ? `**${v}**` : String(v);
    });
    lines.push(`| \`${actual}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Watched cases
  lines.push('## Watched boundary cases');
  lines.push('');
  lines.push('The four cases the stop-point sign-off named explicitly.');
  lines.push('Cases 026 and 027 must land as `fit`; cases 032 and 033');
  lines.push('must land as `welfare-clinical`.');
  lines.push('');
  lines.push('| case | actual | predicted | correct | matched | confidence | rationale |');
  lines.push('| --- | --- | --- | :---: | --- | ---: | --- |');
  for (const r of results) {
    if (!WATCHED.has(r.case_id)) continue;
    const mark = r.correct ? 'yes' : '**NO**';
    lines.push(
      `| \`${r.case_id}\` | \`${r.actual}\` | \`${r.predicted}\` | ${mark} | ${r.matched} | ${r.confidence.toFixed(2)} | ${r.rationale} |`,
    );
  }
  lines.push('');

  // Adversarial signal — ADR-0010 amendment 1
  lines.push('## Adversarial signal (`adversarialSuspected`)');
  lines.push('');
  lines.push('Orthogonal to intent. A safety-signal rule fires whenever');
  lines.push('a canonical adversarial pattern appears in the message,');
  lines.push('regardless of the underlying intent classification. Case');
  lines.push('030 is the specific one — labelled `fit`, carries an');
  lines.push('injection payload; the router should classify `fit` AND');
  lines.push('set the adversarial signal.');
  lines.push('');
  const advResults = results.filter(
    (r) => ADVERSARIAL_EXPECTED.has(r.case_id) || r.adversarialSuspected,
  );
  lines.push(
    '| case | intent (actual → pred) | adversarialSuspected | pattern | correct intent | correct signal |',
  );
  lines.push('| --- | --- | :---: | --- | :---: | :---: |');
  for (const r of advResults) {
    const shouldFire = ADVERSARIAL_EXPECTED.has(r.case_id);
    const intentOk = r.correct ? 'yes' : '**NO**';
    const signalOk =
      r.adversarialSuspected === shouldFire ? 'yes' : shouldFire ? '**MISSED**' : '**FALSE POS**';
    lines.push(
      `| \`${r.case_id}\` | \`${r.actual}\` → \`${r.predicted}\` | ${r.adversarialSuspected ? 'true' : 'false'} | ${r.adversarialPattern ?? '—'} | ${intentOk} | ${signalOk} |`,
    );
  }
  const advCorrect = results.filter(
    (r) => ADVERSARIAL_EXPECTED.has(r.case_id) && r.adversarialSuspected,
  ).length;
  const advFalsePos = results.filter(
    (r) => !ADVERSARIAL_EXPECTED.has(r.case_id) && r.adversarialSuspected,
  ).length;
  lines.push('');
  lines.push(
    `Adversarial detection: ${advCorrect}/${ADVERSARIAL_EXPECTED.size} on the expected set, ${advFalsePos} false positives across the remaining ${results.length - ADVERSARIAL_EXPECTED.size} cases.`,
  );
  lines.push('');

  // Rule vs LLM
  const rvl = ruleVsLlm(results);
  lines.push('## Rule vs LLM split');
  lines.push('');
  lines.push('| layer | cases | correct | accuracy |');
  lines.push('| --- | ---: | ---: | ---: |');
  lines.push(
    `| rules | ${rvl.rule.total} | ${rvl.rule.correct} | ${rvl.rule.total === 0 ? '—' : pct(rvl.rule.correct / rvl.rule.total)} |`,
  );
  lines.push(
    `| llm | ${rvl.llm.total} | ${rvl.llm.correct} | ${rvl.llm.total === 0 ? '—' : pct(rvl.llm.correct / rvl.llm.total)} |`,
  );
  lines.push('');
  lines.push(
    'A rule match at 100% shows the rules match the phrasings the author knew about; the LLM accuracy is the generalisation number.',
  );
  lines.push('');

  // Confidence calibration
  lines.push('## Confidence calibration');
  lines.push('');
  lines.push('If accuracy does not increase with confidence, GW-11');
  lines.push('cannot use the confidence field for deferral. Sprint 2');
  lines.push('needs to know this before building policy on top of it.');
  lines.push('');
  lines.push('| confidence band | cases | correct | accuracy |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const c of confidenceCalibration(results)) {
    lines.push(`| ${c.band} | ${c.n} | ${c.correct} | ${c.n === 0 ? '—' : pct(c.accuracy)} |`);
  }
  lines.push('');

  // Every misclassification
  const misses = results.filter((r) => !r.correct);
  lines.push(`## Misclassifications (${misses.length})`);
  lines.push('');
  if (misses.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| case | actual | predicted | matched | confidence | rationale | query |');
    lines.push('| --- | --- | --- | --- | ---: | --- | --- |');
    for (const r of misses) {
      const q = r.user_input.replace(/\|/g, '\\|');
      const rat = r.rationale.replace(/\|/g, '\\|');
      lines.push(
        `| \`${r.case_id}\` | \`${r.actual}\` | \`${r.predicted}\` | ${r.matched} | ${r.confidence.toFixed(2)} | ${rat} | ${q} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------- Main ----------

async function main(): Promise<void> {
  const apiKey = requireEnv('OPENAI_API_KEY');
  const openai = new OpenAI({ apiKey });
  const router = new HybridRouter(openai);

  const cases = loadCases(DATASET_PATH);
  console.log(`Loaded ${cases.length} cases from ${DATASET_PATH}`);
  console.log(`Running against ${INTENTS.length} intent classes.`);
  console.log('');

  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const started = Date.now();
    const r = await measureOne(router, c);
    const elapsed = Date.now() - started;
    const mark = r.correct ? '✓' : '✗';
    console.log(
      `${padLeft(String(i + 1), 3)}/${cases.length} ${mark} ${padRight(c.id, 45)} ${padRight(`(${r.matched})`, 6)} ${padLeft(`${elapsed}ms`, 7)} ${r.actual} → ${r.predicted}`,
    );
    results.push(r);
  }

  const generatedAt = new Date().toISOString();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = resolve(RESULTS_DIR, `router-baseline-${stamp}.json`);
  const mdPath = resolve(RESULTS_DIR, 'router-baseline.md');

  writeFileSync(jsonPath, JSON.stringify({ generatedAt, dataset: DATASET_PATH, results }, null, 2));
  writeFileSync(mdPath, renderReport(results, generatedAt));

  console.log('');
  console.log('---');
  console.log(`raw results:  ${jsonPath}`);
  console.log(`report (md):  ${mdPath}`);
  console.log(`overall:      ${pct(overallAccuracy(results))}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
