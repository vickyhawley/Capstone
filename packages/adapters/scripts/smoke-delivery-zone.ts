/**
 * GW-21 mandatory close-out smoke. ADR-0016 §5 close-out pattern.
 *
 * Direct tool → in-memory districts → shape verification against the
 * golden cases that carry a populated `expected_delivery_zone`.
 *
 * Design (mirrors smoke-product-substitute-lookup.ts):
 *
 *   - One phase, validation only. `delivery_zone_correct` is
 *     descriptive-first (no threshold being sized), so no
 *     characterisation-vs-validation split.
 *
 *   - Cases without `expected_delivery_zone` are ignored silently —
 *     the delivery-zone axis is orthogonal to the product/substitute
 *     axes, and unrelated cases aren't "skipped" in the substitute
 *     smoke sense.
 *
 *   - No Supabase / OpenAI dependency: the tool is a pure lookup
 *     against `data/delivery-districts.yaml`. Runs in <1s locally.
 *
 * Usage:
 *   tsx --env-file=../../.env.local scripts/smoke-delivery-zone.ts
 *
 * (The env-file flag is only for parity with the other smokes;
 * this script reads no env vars.)
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  DeliveryZoneTool,
  loadDeliveryDistricts,
  type DeliveryZoneResult,
  type DeliveryZoneStatus,
} from '../src/tool-registry/delivery-zone-tool.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '../../..');
const CASES_PATH = resolve(REPO_ROOT, 'evals/datasets/sprint-1/cases.jsonl');
const DISTRICTS_PATH = resolve(REPO_ROOT, 'data/delivery-districts.yaml');

interface EvalCaseLite {
  readonly id: string;
  readonly intent: string;
  readonly user_input: string;
  readonly expected_postcode?: string;
  readonly expected_delivery_zone?: DeliveryZoneStatus;
}

interface CaseVerdict {
  readonly caseId: string;
  readonly postcode: string;
  readonly expected: DeliveryZoneStatus;
  readonly got: DeliveryZoneStatus | null;
  readonly matchedLocality: string | null;
  readonly reason: string;
  readonly pass: boolean;
}

async function loadSmokeCases(): Promise<readonly EvalCaseLite[]> {
  const raw = await readFile(CASES_PATH, 'utf8');
  const out: EvalCaseLite[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const parsed = JSON.parse(trimmed) as EvalCaseLite;
    if (parsed.expected_delivery_zone && parsed.expected_postcode) {
      out.push(parsed);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const districts = await loadDeliveryDistricts(DISTRICTS_PATH);
  const tool = new DeliveryZoneTool(districts);

  const cases = await loadSmokeCases();
  console.log(
    `Loaded ${cases.length} delivery-zone case(s) (gate: expected_delivery_zone + expected_postcode).\n`,
  );

  const verdicts: CaseVerdict[] = [];
  for (const c of cases) {
    const postcode = c.expected_postcode as string;
    const expected = c.expected_delivery_zone as DeliveryZoneStatus;
    const invocation = await tool.invoke({
      name: 'logistics.delivery_zone',
      args: { postcode },
    });
    if (!invocation.ok) {
      verdicts.push({
        caseId: c.id,
        postcode,
        expected,
        got: null,
        matchedLocality: null,
        reason: `tool.invoke failed: ${invocation.error}`,
        pass: false,
      });
      continue;
    }
    const value = invocation.value as DeliveryZoneResult;
    verdicts.push({
      caseId: c.id,
      postcode,
      expected,
      got: value.status,
      matchedLocality: value.matchedDistrict?.locality ?? null,
      reason: value.reason,
      pass: value.status === expected,
    });
  }

  console.log('=== Per-case verdicts ===\n');
  let passed = 0;
  let failed = 0;
  for (const v of verdicts) {
    const badge = v.pass ? 'PASS' : 'FAIL';
    console.log(
      `  ${badge}  ${v.caseId.padEnd(48)}  postcode=${v.postcode.padEnd(6)}  expected=${v.expected.padEnd(15)}  got=${String(v.got ?? 'null').padEnd(15)}`,
    );
    if (v.matchedLocality) {
      console.log(`         matched: ${v.matchedLocality}`);
    }
    console.log(`         reason: ${v.reason}`);
    if (v.pass) passed += 1;
    else failed += 1;
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`  ${passed}/${cases.length} pass; ${failed} fail`);

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
