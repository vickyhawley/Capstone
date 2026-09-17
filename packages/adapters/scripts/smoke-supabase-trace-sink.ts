/**
 * GW-25 mandatory smoke — direct adapter → Supabase → readback.
 * ADR-0015 §Consequences names this as required before the story
 * closes. Runs OUT-OF-BAND from /api/answer because the current
 * NoopPlanner + StubToolRegistry pairing means the tool loop
 * terminates on iteration 0 without ever calling the sink; the
 * loop-integrated smoke has to wait for GW-20's real tools.
 *
 * What this proves:
 *   1. The SupabaseTraceSink adapter writes a row when record() is
 *      called with a valid Span.
 *   2. The row is queryable by trace_id + span_id.
 *   3. Every column comes back with the expected value + type.
 *   4. The duplicate-catch path fires on re-insert of the same
 *      (trace_id, span_id) — proves ADR-0015 §Decision 10's narrow
 *      catch + counter behaviour against a real Postgres.
 *
 * What this does NOT prove:
 *   - The tool loop calls the sink (GW-18 unit tests cover that).
 *   - End-to-end /api/answer → sink → DB (requires real tools;
 *     mandatory-smoke deferred to GW-20 close-out).
 *
 * Cleanup: deletes the smoke rows after the check. Safe to run
 * against production Supabase — the trace_id is deliberately
 * distinctive so operators tracing an incident don't confuse smoke
 * rows with real traffic.
 *
 * Usage:
 *   tsx --env-file=../../.env.local scripts/smoke-supabase-trace-sink.ts
 */
import { createClient } from '@supabase/supabase-js';

import { SupabaseTraceSink } from '../src/trace-sink/supabase-trace-sink.js';

const SMOKE_TRACE_ID = `gw-25-smoke-${Date.now()}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const supabase = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  const sink = new SupabaseTraceSink(supabase);

  // Positive path: record a valid span, read it back, compare every
  // column.
  const startedAt = new Date().toISOString();
  await sink.record({
    traceId: SMOKE_TRACE_ID,
    spanId: 'span-1',
    parentSpanId: 'parent-span',
    kind: 'tool-call',
    startedAt,
    durationMs: 42,
    attributes: { tool_name: 'smoke-tool', ok: true, iteration: 0 },
  });

  const { data: rows, error } = await supabase
    .from('traces')
    .select('*')
    .eq('trace_id', SMOKE_TRACE_ID);
  if (error) {
    console.error(`readback failed: ${error.message}`);
    process.exit(1);
  }
  if (!rows || rows.length !== 1) {
    console.error(`expected exactly 1 row, got ${rows?.length ?? 0}`);
    process.exit(1);
  }
  const row = rows[0] as Record<string, unknown>;

  const checks: [string, unknown, unknown][] = [
    ['trace_id', row['trace_id'], SMOKE_TRACE_ID],
    ['span_id', row['span_id'], 'span-1'],
    ['parent_span_id', row['parent_span_id'], 'parent-span'],
    ['kind', row['kind'], 'tool-call'],
    ['duration_ms', row['duration_ms'], 42],
    ['error', row['error'], null],
  ];
  let failed = false;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}`);
    if (!ok) failed = true;
  }
  // attributes is JSONB — deep-equal check.
  const attrs = row['attributes'] as Record<string, unknown>;
  const attrsOk =
    attrs['tool_name'] === 'smoke-tool' && attrs['ok'] === true && attrs['iteration'] === 0;
  console.log(`  ${attrsOk ? 'PASS' : 'FAIL'}  attributes: ${JSON.stringify(attrs)}`);
  if (!attrsOk) failed = true;

  // Duplicate path: same (trace_id, span_id), sink should catch
  // narrowly + increment the counter without throwing.
  await sink.record({
    traceId: SMOKE_TRACE_ID,
    spanId: 'span-1', // same as above — should trigger 23505
    kind: 'tool-call',
    startedAt,
    durationMs: 42,
    attributes: {},
  });
  const dupCount = sink.getDuplicateSpanCount();
  const dupOk = dupCount === 1;
  console.log(`  ${dupOk ? 'PASS' : 'FAIL'}  duplicate-catch counter: ${dupCount} (expected 1)`);
  if (!dupOk) failed = true;

  // Cleanup — leave no smoke rows behind.
  const { error: deleteError } = await supabase
    .from('traces')
    .delete()
    .eq('trace_id', SMOKE_TRACE_ID);
  if (deleteError) {
    console.error(`cleanup failed (row left in DB): ${deleteError.message}`);
    failed = true;
  } else {
    console.log(`  PASS  cleanup: removed smoke rows for trace_id=${SMOKE_TRACE_ID}`);
  }

  if (failed) {
    console.error('\nSMOKE FAILED');
    process.exit(1);
  }
  console.log('\nSMOKE PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
