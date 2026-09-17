/**
 * Supabase-backed TraceSink. GW-25, ADR-0015.
 *
 * Writes one row per Span into the `traces` table (migration 004).
 * Append-only — no upsert. Composite PK on (trace_id, span_id)
 * means duplicate emissions surface as Postgres error 23505
 * (unique_violation).
 *
 * Duplicate handling (ADR-0015 §Decision 10):
 * - **Narrow catch on 23505 only.** Log + increment an in-memory
 *   counter, return normally. A blanket try/catch would hide the
 *   bug; a throw would put an exception on a path the port
 *   contract says must be inert.
 * - **Any other error propagates.** Real infrastructure failures
 *   (network partition, table missing, permission denied) are
 *   caught by `tool-loop.ts`'s `safeTraceRecord` wrapper, per the
 *   port's best-effort contract. The adapter itself doesn't need
 *   a second layer of swallowing.
 *
 * PII: per port contract, redaction happens before this sink. The
 * adapter does not scan or transform attribute contents.
 *
 * Future consumers (ADR-0015 §Decision 8) can rely on standard
 * attribute keys for cost/tokens: `input_tokens`, `output_tokens`,
 * `cost_usd`, `model`. GW-24 (model tiering) lands into this shape.
 */
import type { Span, TraceSink } from '@groundwork/core';
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';

/**
 * Postgres SQLSTATE for unique_violation. Documented separately so
 * a future reader can trace the number back to a spec reference:
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const PG_UNIQUE_VIOLATION = '23505';

export class SupabaseTraceSink implements TraceSink {
  private duplicateSpanCount = 0;

  constructor(private readonly supabase: SupabaseClient) {}

  async record(span: Span): Promise<void> {
    const row = {
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId ?? null,
      kind: span.kind,
      started_at: span.startedAt,
      duration_ms: span.durationMs,
      attributes: span.attributes,
      error: span.error ?? null,
    };

    const { error } = await this.supabase.from('traces').insert(row);
    if (!error) return;

    if (isDuplicateSpan(error)) {
      this.duplicateSpanCount += 1;
      // Log line is the ADR-0015 §10 "loud signal" for duplicate
      // emit. Non-zero counter across a process's lifetime means
      // the loop is emitting the same (trace_id, span_id) twice —
      // investigate the tool-loop's span_id generator or the
      // caller's span-id-passing logic.
      console.error(
        `[SupabaseTraceSink] duplicate span rejected: trace_id=${span.traceId} span_id=${span.spanId} kind=${span.kind}. Duplicate count this process: ${this.duplicateSpanCount}.`,
      );
      return;
    }

    // Any other error propagates. The loop's `safeTraceRecord`
    // wrapper will swallow it per the port contract; but the
    // exception carries the underlying Postgres message so it
    // shows up in server logs.
    throw new Error(`traces insert failed: ${error.message} (code=${error.code ?? 'unknown'})`);
  }

  /**
   * Duplicate-span count since this adapter instance was created.
   * Exposed for a future health-check endpoint (`/api/health` or
   * `/api/traces/health`) per ADR-0015 §Decision 10. Not
   * persisted; resets on process restart. If duplicates recur,
   * they'll recur after restart too — the counter is a "canary
   * for this process" not a permanent record.
   */
  getDuplicateSpanCount(): number {
    return this.duplicateSpanCount;
  }
}

function isDuplicateSpan(error: PostgrestError): boolean {
  return error.code === PG_UNIQUE_VIOLATION;
}
