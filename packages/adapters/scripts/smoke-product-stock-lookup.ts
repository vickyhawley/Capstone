/**
 * GW-20 mandatory close-out smoke — direct tool → hybrid retriever
 * → Supabase → shape verification against golden-case-derived
 * queries. ADR-0016 §7 names this as required before Story 4
 * closes. Same discipline as ADR-0015's mandatory smoke.
 *
 * What this proves:
 *   1. Hybrid retrieval (dense + sparse + RRF) reaches real
 *      Supabase — the tool is not testing itself against a stub.
 *   2. For every case with `expected_stock_status` populated in
 *      `evals/datasets/sprint-1/cases.jsonl`, the tool returns the
 *      SME-annotated shape.
 *   3. Exact matches carry non-empty `matchedChunkIds` + a
 *      `matchScore` at/above the caller's floor.
 *   4. Unavailable results carry non-null `outOfScopeReason` (from
 *      `data/nfcs-out-of-scope.yaml`).
 *   5. Pending results carry non-null `pendingReason` (from
 *      `data/nfcs-pending.yaml`).
 *   6. The score distribution grouped by expected status is
 *      reported BEFORE any pass/fail summary — per the user
 *      instruction to see the distribution and name the
 *      `minMatchScore` floor ourselves rather than have one picked.
 *
 * What this does NOT prove:
 *   - The tool loop emits a trace span when invoking this tool
 *     (that's GW-18's unit tests + GW-25's smoke — the tool
 *     itself does not emit spans; the loop wrapping the invoke
 *     call does).
 *   - End-to-end `/api/answer` → tool → sink → DB (the current
 *     NoopPlanner in the default deps never dispatches, so a
 *     loop-integrated smoke has to wait for the Tier-1 dispatch
 *     shim or a real planner).
 *
 * Threshold discipline (ADR-0016 §3):
 *   - This smoke runs with `minMatchScore: null` — characterisation
 *     mode, no floor. The reported distribution is what task #9
 *     (baseline run) inspects to name the floor. `null` is NEVER
 *     passed on any customer-reaching path; see
 *     `apps/api/src/answer.ts::defaultAnswerDeps` which lets the
 *     tool's `DEFAULT_MIN_MATCH_SCORE` apply.
 *
 * Usage:
 *   tsx --env-file=../../.env.local scripts/smoke-product-stock-lookup.ts
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

import { rrf } from '../src/retriever/fusion.js';
import { HybridRetriever } from '../src/retriever/hybrid-retriever.js';
import { PgTsRankRetriever } from '../src/retriever/pg-ts-rank-retriever.js';
import { PgvectorDenseRetriever } from '../src/retriever/pgvector-dense-retriever.js';
import {
  ProductStockLookupTool,
  type StockLookupResult,
  type StockStatus,
  loadStatusOverrideList,
} from '../src/tool-registry/product-stock-lookup-tool.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../..');
const OUT_OF_SCOPE_PATH = resolve(REPO_ROOT, 'data/nfcs-out-of-scope.yaml');
const PENDING_PATH = resolve(REPO_ROOT, 'data/nfcs-pending.yaml');
const CASES_PATH = resolve(REPO_ROOT, 'evals/datasets/sprint-1/cases.jsonl');

interface EvalCaseLite {
  readonly id: string;
  readonly intent: string;
  readonly user_input: string;
  readonly expected_stock_status?: StockStatus;
  readonly expected_product_query?: string;
}

interface CaseResult {
  readonly caseId: string;
  readonly productQuery: string;
  readonly expected: StockStatus;
  readonly actual: StockStatus | null;
  readonly matchScore: number | null;
  readonly matchedChunkIds: readonly string[];
  readonly outOfScopeReason: string | null;
  readonly pendingReason: string | null;
  readonly errors: readonly string[];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function loadSmokeCases(): Promise<readonly EvalCaseLite[]> {
  const raw = await readFile(CASES_PATH, 'utf8');
  const cases: EvalCaseLite[] = [];
  for (const [lineno, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    let parsed: EvalCaseLite;
    try {
      parsed = JSON.parse(trimmed) as EvalCaseLite;
    } catch (err) {
      throw new Error(`cases.jsonl:${lineno + 1}: parse error — ${(err as Error).message}`);
    }
    if (parsed.expected_stock_status && parsed.expected_product_query) {
      cases.push(parsed);
    }
  }
  return cases;
}

function verifyShape(expected: StockStatus, result: StockLookupResult): readonly string[] {
  const errors: string[] = [];
  if (result.status !== expected) {
    errors.push(`status mismatch: expected=${expected} actual=${result.status}`);
  }
  switch (expected) {
    case 'exact':
      if (result.matchedChunkIds.length === 0) {
        errors.push('exact: matchedChunkIds is empty (ADR-0016 §2 requires ≥1)');
      }
      if (result.outOfScopeReason !== null) errors.push('exact: outOfScopeReason should be null');
      if (result.pendingReason !== null) errors.push('exact: pendingReason should be null');
      break;
    case 'orderable':
      if (result.matchedChunkIds.length !== 0) {
        errors.push('orderable: matchedChunkIds should be empty');
      }
      if (result.outOfScopeReason !== null) {
        errors.push('orderable: outOfScopeReason should be null');
      }
      if (result.pendingReason !== null) errors.push('orderable: pendingReason should be null');
      break;
    case 'pending':
      if (result.pendingReason === null) {
        errors.push('pending: pendingReason must be non-null (ADR-0016 §2)');
      }
      if (result.outOfScopeReason !== null) {
        errors.push('pending: outOfScopeReason should be null');
      }
      break;
    case 'unavailable':
      if (result.outOfScopeReason === null) {
        errors.push('unavailable: outOfScopeReason must be non-null (ADR-0016 §2)');
      }
      if (result.pendingReason !== null) {
        errors.push('unavailable: pendingReason should be null');
      }
      break;
  }
  return errors;
}

function reportDistribution(results: readonly CaseResult[]): void {
  console.log('\n=== Cosine-score distribution (dense top-1, minMatchScore: null) ===');
  console.log("ADR-0016 §3 Option A: the floor applies to the dense retriever's");
  console.log('top-1 cosine score, not the RRF-fused hybrid output. Reported');
  console.log('first, before pass/fail, per user instruction — the threshold is');
  console.log('named after inspection, not before.\n');

  const byStatus = new Map<StockStatus, number[]>();
  for (const r of results) {
    const list = byStatus.get(r.expected) ?? [];
    if (r.matchScore !== null) list.push(r.matchScore);
    byStatus.set(r.expected, list);
  }
  const order: StockStatus[] = ['exact', 'orderable', 'pending', 'unavailable'];
  for (const status of order) {
    const scores = (byStatus.get(status) ?? []).slice().sort((a, b) => a - b);
    if (scores.length === 0) {
      console.log(`  ${status.padEnd(12)}  no match-scores (0 cases with retrieval hits)`);
      continue;
    }
    const min = scores[0];
    const max = scores[scores.length - 1];
    const median = scores[Math.floor(scores.length / 2)];
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(
      `  ${status.padEnd(12)}  n=${scores.length}  min=${fmt(min)}  median=${fmt(median)}  mean=${fmt(
        mean,
      )}  max=${fmt(max)}`,
    );
    console.log(`               scores: ${scores.map(fmt).join(', ')}`);
  }
  console.log('');
  console.log('Threshold sizing — the ADR-0016 §3 provisional cosine floor is 0.5.');
  console.log('Vix names the confirmed floor at close-out based on the cosine');
  console.log("distribution above (a floor safely below any 'exact' score but");
  console.log("safely above any non-'exact' score is the target). Do NOT assume");
  console.log('0.5 transfers just because it is cosine — measure, then name.');
}

function fmt(x: number | undefined): string {
  return x === undefined ? 'n/a' : x.toFixed(3);
}

async function main(): Promise<void> {
  const openai = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { persistSession: false },
    },
  );

  const dense = new PgvectorDenseRetriever(supabase, openai);
  const sparse = new PgTsRankRetriever(supabase);
  const retriever = new HybridRetriever(dense, sparse, rrf());

  const [outOfScope, pending, cases] = await Promise.all([
    loadStatusOverrideList(OUT_OF_SCOPE_PATH),
    loadStatusOverrideList(PENDING_PATH),
    loadSmokeCases(),
  ]);

  console.log(`Loaded ${cases.length} smoke cases with expected_stock_status.`);
  console.log(`Out-of-scope entries: ${outOfScope.length}. Pending entries: ${pending.length}.\n`);

  // ADR-0016 §3 Option A: floor applies to the dense retriever's
  // top-1 cosine score, not the RRF-fused hybrid output. Pass both.
  const tool = new ProductStockLookupTool(retriever, dense, outOfScope, pending);

  // -------------------------------------------------------------------
  // Phase 1 — Characterisation (minMatchScore: null → no floor).
  //
  // Every retrieval hit becomes `exact` regardless of score in this
  // phase, because `null` means "return the top-1 result as exact if
  // one exists". So the returned status is not shape-verified here —
  // the whole point is to collect the top-1 cosine score per case
  // (from the dense retriever, since ADR-0016 §3 Option A applies
  // the floor there) so Vix can see the distribution and name the
  // cosine floor at close-out. `matchScore` on the result surfaces
  // the cosine number, not the RRF-fused score.
  // -------------------------------------------------------------------
  const characterisation: CaseResult[] = [];
  for (const c of cases) {
    const productQuery = c.expected_product_query as string;
    const expected = c.expected_stock_status as StockStatus;
    const invocation = await tool.invoke({
      name: 'product.stock_lookup',
      args: { productQuery, minMatchScore: null },
    });
    if (!invocation.ok) {
      characterisation.push({
        caseId: c.id,
        productQuery,
        expected,
        actual: null,
        matchScore: null,
        matchedChunkIds: [],
        outOfScopeReason: null,
        pendingReason: null,
        errors: [`tool.invoke failed: ${invocation.error}`],
      });
      continue;
    }
    const value = invocation.value as StockLookupResult;
    characterisation.push({
      caseId: c.id,
      productQuery,
      expected,
      actual: value.status,
      matchScore: value.matchScore,
      matchedChunkIds: value.matchedChunkIds,
      outOfScopeReason: value.outOfScopeReason,
      pendingReason: value.pendingReason,
      errors: [],
    });
  }
  reportDistribution(characterisation);

  // -------------------------------------------------------------------
  // Phase 2 — Shape validation against the customer-facing default
  // (ADR-0016 §3 provisional floor = DEFAULT_MIN_MATCH_SCORE = 0.5).
  //
  // No `minMatchScore` passed → the tool's own default applies. This
  // is what customer-reaching paths will see. Shape verification runs
  // here because in this mode the tool's four-state ordering is what
  // decides the status. The smoke's exit code is driven by this phase.
  // -------------------------------------------------------------------
  console.log(
    '\n\n=== Phase 2 — Shape validation @ cosine floor (DEFAULT_MIN_MATCH_SCORE = 0.5) ===\n',
  );
  const validation: CaseResult[] = [];
  for (const c of cases) {
    const productQuery = c.expected_product_query as string;
    const expected = c.expected_stock_status as StockStatus;
    const invocation = await tool.invoke({
      name: 'product.stock_lookup',
      args: { productQuery },
    });
    if (!invocation.ok) {
      validation.push({
        caseId: c.id,
        productQuery,
        expected,
        actual: null,
        matchScore: null,
        matchedChunkIds: [],
        outOfScopeReason: null,
        pendingReason: null,
        errors: [`tool.invoke failed: ${invocation.error}`],
      });
      continue;
    }
    const value = invocation.value as StockLookupResult;
    validation.push({
      caseId: c.id,
      productQuery,
      expected,
      actual: value.status,
      matchScore: value.matchScore,
      matchedChunkIds: value.matchedChunkIds,
      outOfScopeReason: value.outOfScopeReason,
      pendingReason: value.pendingReason,
      errors: verifyShape(expected, value),
    });
  }

  let passed = 0;
  let failed = 0;
  for (const r of validation) {
    const ok = r.errors.length === 0;
    const badge = ok ? 'PASS' : 'FAIL';
    const score = r.matchScore === null ? 'n/a' : fmt(r.matchScore);
    console.log(
      `  ${badge}  ${r.caseId.padEnd(56)}  expected=${r.expected.padEnd(12)} actual=${
        r.actual ?? 'null'
      } score=${score}`,
    );
    if (!ok) {
      for (const err of r.errors) console.log(`         ${err}`);
      failed += 1;
    } else {
      passed += 1;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Phase 2 (@ default floor): ${passed}/${validation.length} pass; ${failed} fail`);

  if (failed > 0) {
    console.error('\nSMOKE FAILED — see Phase 1 distribution for what the floor');
    console.error('would need to change to; task #10 close-out records the decision.');
    process.exit(1);
  }
  console.log('\nSMOKE PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
