/**
 * Unit tests for SupabaseTraceSink. GW-25, ADR-0015.
 *
 * Scope of these tests is narrow — the Supabase fluent client is
 * mocked with a minimal fake, so we're not testing that the
 * insert-payload conversion matches Postgres wire format. What we
 * *are* testing is the duplicate-handling contract that ADR-0015
 * §Decision 10 spelled out:
 *
 * - unique_violation (Postgres 23505) is caught narrowly + counter
 *   increments + no throw.
 * - Any other error propagates.
 * - No error → clean return, counter unchanged.
 * - Insert payload matches Span shape with correct snake_case
 *   conversion.
 *
 * Full DB integration is verified via the manual SQL smoke in
 * the GW-25 close-out (ADR-0015 §Consequences — producer-ahead-
 * of-consumer risk mitigation).
 */
import type { Span } from '@groundwork/core';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SupabaseTraceSink } from './supabase-trace-sink.js';

interface InsertCall {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

/**
 * Minimal fake for the `.from('traces').insert(row)` call. Records
 * every call and returns the queued error (or null for success).
 */
function makeFakeClient(errors: (PostgrestError | null)[]): {
  client: SupabaseClient;
  calls: InsertCall[];
} {
  const calls: InsertCall[] = [];
  let i = 0;
  const client = {
    from(table: string) {
      return {
        async insert(row: Record<string, unknown>) {
          calls.push({ table, row });
          const err = errors[i] ?? null;
          i += 1;
          return { error: err, data: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 't-1',
    spanId: 's-1',
    kind: 'tool-call',
    startedAt: '2026-09-17T12:00:00.000Z',
    durationMs: 42,
    attributes: { tool_name: 'stock-lookup', ok: true },
    ...overrides,
  };
}

const uniqueViolation: PostgrestError = {
  message: 'duplicate key value violates unique constraint "traces_pkey"',
  code: '23505',
  details: '',
  hint: '',
  name: 'PostgrestError',
  toJSON: () => ({}),
} as unknown as PostgrestError;

const permissionDenied: PostgrestError = {
  message: 'permission denied for table traces',
  code: '42501',
  details: '',
  hint: '',
  name: 'PostgrestError',
  toJSON: () => ({}),
} as unknown as PostgrestError;

const networkPartition: PostgrestError = {
  message: 'network error',
  code: 'PGRST000',
  details: '',
  hint: '',
  name: 'PostgrestError',
  toJSON: () => ({}),
} as unknown as PostgrestError;

describe('SupabaseTraceSink — successful insert', () => {
  it('records a span with the expected snake_case row shape', async () => {
    const { client, calls } = makeFakeClient([null]);
    const sink = new SupabaseTraceSink(client);
    await sink.record(makeSpan({ parentSpanId: 'p-1', error: 'some error' }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('traces');
    expect(calls[0]?.row).toEqual({
      trace_id: 't-1',
      span_id: 's-1',
      parent_span_id: 'p-1',
      kind: 'tool-call',
      started_at: '2026-09-17T12:00:00.000Z',
      duration_ms: 42,
      attributes: { tool_name: 'stock-lookup', ok: true },
      error: 'some error',
    });
  });

  it('nulls parent_span_id and error when the Span omits them', async () => {
    const { client, calls } = makeFakeClient([null]);
    const sink = new SupabaseTraceSink(client);
    await sink.record(makeSpan());

    expect(calls[0]?.row['parent_span_id']).toBeNull();
    expect(calls[0]?.row['error']).toBeNull();
  });

  it('leaves the duplicate counter at zero on a clean insert', async () => {
    const { client } = makeFakeClient([null]);
    const sink = new SupabaseTraceSink(client);
    await sink.record(makeSpan());
    expect(sink.getDuplicateSpanCount()).toBe(0);
  });
});

describe('SupabaseTraceSink — duplicate handling (ADR-0015 §10)', () => {
  it('catches unique_violation narrowly + increments counter + does not throw', async () => {
    const { client } = makeFakeClient([uniqueViolation]);
    const sink = new SupabaseTraceSink(client);

    // Should NOT throw. Port contract: sinks are best-effort. The
    // loop's safeTraceRecord catches anyway, but the adapter
    // shouldn't be relying on that for the duplicate case — the
    // duplicate IS the loud signal, not an error condition.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sink.record(makeSpan())).resolves.toBeUndefined();
    expect(sink.getDuplicateSpanCount()).toBe(1);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toMatch(/duplicate span rejected/i);
    spy.mockRestore();
  });

  it('counter accumulates across multiple duplicates in the same process', async () => {
    const { client } = makeFakeClient([uniqueViolation, uniqueViolation, uniqueViolation]);
    const sink = new SupabaseTraceSink(client);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sink.record(makeSpan({ spanId: 's-1' }));
    await sink.record(makeSpan({ spanId: 's-2' }));
    await sink.record(makeSpan({ spanId: 's-3' }));

    expect(sink.getDuplicateSpanCount()).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('a fresh SupabaseTraceSink instance starts with counter=0', async () => {
    const { client } = makeFakeClient([]);
    const sink = new SupabaseTraceSink(client);
    expect(sink.getDuplicateSpanCount()).toBe(0);
  });
});

describe('SupabaseTraceSink — non-duplicate errors propagate (ADR-0015 §5)', () => {
  it('permission denied throws — real infra failure', async () => {
    const { client } = makeFakeClient([permissionDenied]);
    const sink = new SupabaseTraceSink(client);
    await expect(sink.record(makeSpan())).rejects.toThrow(/permission denied/);
  });

  it('network partition throws', async () => {
    const { client } = makeFakeClient([networkPartition]);
    const sink = new SupabaseTraceSink(client);
    await expect(sink.record(makeSpan())).rejects.toThrow(/network error/);
  });

  it('non-duplicate error does NOT increment the duplicate counter', async () => {
    const { client } = makeFakeClient([permissionDenied]);
    const sink = new SupabaseTraceSink(client);
    await expect(sink.record(makeSpan())).rejects.toThrow();
    expect(sink.getDuplicateSpanCount()).toBe(0);
  });

  it('error message includes the Postgres error code so the log shows both', async () => {
    const { client } = makeFakeClient([permissionDenied]);
    const sink = new SupabaseTraceSink(client);
    await expect(sink.record(makeSpan())).rejects.toThrow(/code=42501/);
  });
});

describe('SupabaseTraceSink — success + duplicate + success sequence', () => {
  it('interleaved failures leave the counter reflecting only duplicates', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = makeFakeClient([null, uniqueViolation, null, uniqueViolation]);
    const sink = new SupabaseTraceSink(client);
    await sink.record(makeSpan({ spanId: 's-1' }));
    await sink.record(makeSpan({ spanId: 's-2' }));
    await sink.record(makeSpan({ spanId: 's-3' }));
    await sink.record(makeSpan({ spanId: 's-4' }));
    expect(sink.getDuplicateSpanCount()).toBe(2);
    spy.mockRestore();
  });
});
