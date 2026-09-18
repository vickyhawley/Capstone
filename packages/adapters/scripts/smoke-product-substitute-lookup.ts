/**
 * GW-19 mandatory close-out smoke. ADR-0005 addendum 2026-09-18.
 *
 * Direct tool → dense retriever → Supabase → shape verification
 * against the golden cases tagged `substitute-offered` or
 * `price-tier-substitute` that carry a populated
 * `expected_substitute_handle`.
 *
 * Design (per the sprint-3 scope-freeze rule "ship the story, run
 * the smoke, record the finding, move on"):
 *
 *   - One phase, validation only. No characterisation-vs-validation
 *     split like GW-20's smoke — GW-19 has no threshold being sized,
 *     and `substitute_offered_correct` is descriptive-first with no
 *     gating consumer.
 *
 *   - Anchor-coverage reported as a line in the output rather than
 *     a phase. Under Path B (top-1-metadata anchor), the tool falls
 *     through with a `note` when the anchor's primary attribute is
 *     null (ADR-0004 coverage gap) or when the anchor's type isn't
 *     in the SUBSTITUTE_PRIMARY_ATTRIBUTE map. The line reports how
 *     many cases hit those paths.
 *
 *   - Cases without `expected_substitute_handle` are skipped with a
 *     note. Case 043 (Devon haylage) is unlabelled pending SME
 *     follow-up; measuring against a guess would be worse than
 *     abstaining.
 *
 * Usage:
 *   tsx --env-file=../../.env.local scripts/smoke-product-substitute-lookup.ts
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

import { PgvectorDenseRetriever } from '../src/retriever/pgvector-dense-retriever.js';
import {
  ProductSubstituteLookupTool,
  type SubstituteLookupResult,
} from '../src/tool-registry/product-substitute-lookup-tool.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../..');
const CASES_PATH = resolve(REPO_ROOT, 'evals/datasets/sprint-1/cases.jsonl');

interface EvalCaseLite {
  readonly id: string;
  readonly intent: string;
  readonly user_input: string;
  readonly expected_product_query?: string;
  readonly expected_substitute_handle?: string;
  readonly tags?: readonly string[];
}

interface CaseVerdict {
  readonly caseId: string;
  readonly productQuery: string;
  readonly expected: string;
  readonly got: readonly string[];
  readonly anchorHandle: string | null;
  readonly anchorType: string | null;
  readonly anchorAttribute: string | null;
  readonly note: string | null;
  readonly pass: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function loadSmokeCases(): Promise<{
  scored: readonly EvalCaseLite[];
  skipped: readonly EvalCaseLite[];
}> {
  // The correct signal for "this case has a substitute check to
  // run" is presence of `expected_substitute_handle`. Tag membership
  // (`substitute-offered`, `price-tier-substitute`) is a related
  // taxonomy but not the smoke's gate — case 044 is tagged
  // `three-state-stock` and carries a substitute handle. The
  // "skipped" bucket collects tagged-but-unlabelled cases
  // (`substitute-offered` / `price-tier-substitute` tag + null
  // handle → SME follow-up pending) for reporting.
  const raw = await readFile(CASES_PATH, 'utf8');
  const scored: EvalCaseLite[] = [];
  const skipped: EvalCaseLite[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const parsed = JSON.parse(trimmed) as EvalCaseLite;
    if (!parsed.expected_product_query) continue;
    if (parsed.expected_substitute_handle) {
      scored.push(parsed);
      continue;
    }
    const tags = parsed.tags ?? [];
    if (tags.includes('substitute-offered') || tags.includes('price-tier-substitute')) {
      skipped.push(parsed);
    }
  }
  return { scored, skipped };
}

async function main(): Promise<void> {
  const openai = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  const dense = new PgvectorDenseRetriever(supabase, openai);
  const tool = new ProductSubstituteLookupTool(dense);

  const { scored, skipped } = await loadSmokeCases();
  console.log(
    `Loaded ${scored.length} scored substitute cases; ${skipped.length} unlabelled (skipped).`,
  );
  for (const s of skipped) {
    console.log(`  skip: ${s.id} — no expected_substitute_handle (SME follow-up pending)`);
  }
  console.log('');

  const verdicts: CaseVerdict[] = [];
  let anchorHitCount = 0;
  let anchorNoneCount = 0;
  let anchorAttributeNullCount = 0;
  let anchorTypeNotMappedCount = 0;

  for (const c of scored) {
    const productQuery = c.expected_product_query as string;
    const expected = c.expected_substitute_handle as string;
    // stockStatus: 'orderable' — the substitute path is for non-exact
    // outcomes. The value here doesn't hit the tool's `exact`
    // short-circuit; 'orderable' is representative of the real case
    // shapes (022 orderable-with-substitute; 044 orderable-with-
    // substitute after handle-match falls through).
    const invocation = await tool.invoke({
      name: 'product.substitute_lookup',
      args: { productQuery, stockStatus: 'orderable' },
    });
    if (!invocation.ok) {
      verdicts.push({
        caseId: c.id,
        productQuery,
        expected,
        got: [],
        anchorHandle: null,
        anchorType: null,
        anchorAttribute: null,
        note: `tool.invoke failed: ${invocation.error}`,
        pass: false,
      });
      continue;
    }
    const value = invocation.value as SubstituteLookupResult;
    if (value.anchor?.primaryAttribute) {
      anchorHitCount += 1;
    } else if (value.anchor && !value.anchor.primaryAttribute) {
      // Anchor found but primary attribute null (ADR-0004 gap) — or
      // type not in the map. Distinguish via note.
      if ((value.note ?? '').includes('SUBSTITUTE_PRIMARY_ATTRIBUTE')) {
        anchorTypeNotMappedCount += 1;
      } else {
        anchorAttributeNullCount += 1;
      }
    } else {
      anchorNoneCount += 1;
    }
    const gotHandles = value.substitutes.map((s) => s.handle);
    verdicts.push({
      caseId: c.id,
      productQuery,
      expected,
      got: gotHandles,
      anchorHandle: value.anchor?.handle ?? null,
      anchorType: value.anchor?.type ?? null,
      anchorAttribute: value.anchor?.primaryAttribute
        ? `${value.anchor.primaryAttribute.key}=${value.anchor.primaryAttribute.value}`
        : null,
      note: value.note,
      pass: gotHandles.includes(expected),
    });
  }

  console.log('=== Per-case verdicts ===\n');
  let passed = 0;
  let failed = 0;
  for (const v of verdicts) {
    const badge = v.pass ? 'PASS' : 'FAIL';
    console.log(
      `  ${badge}  ${v.caseId.padEnd(56)}  expected=${v.expected}  got=${JSON.stringify(v.got)}`,
    );
    if (v.anchorType) {
      console.log(
        `         anchor handle=${v.anchorHandle ?? 'null'} type=${v.anchorType} attribute=${v.anchorAttribute ?? 'null'}`,
      );
    }
    if (v.note) console.log(`         note: ${v.note}`);
    if (v.pass) passed += 1;
    else failed += 1;
  }

  console.log('');
  console.log('=== Anchor coverage (Path B — top-1-metadata) ===');
  console.log(`  anchor + primary attribute present:   ${anchorHitCount}`);
  console.log(
    `  anchor present, primary attribute null (ADR-0004 gap): ${anchorAttributeNullCount}`,
  );
  console.log(`  anchor present, type not in map:      ${anchorTypeNotMappedCount}`);
  console.log(`  no anchor (empty retrieval / missing metadata): ${anchorNoneCount}`);

  console.log('');
  console.log('=== Summary ===');
  console.log(`  ${passed}/${scored.length} pass; ${failed} fail`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} case(s) skipped (unlabelled pending SME follow-up)`);
  }

  if (failed > 0) {
    console.error('\nSMOKE FAILED');
    process.exit(1);
  }
  console.log('\nSMOKE PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
