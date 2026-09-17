/**
 * TraceSink port.
 *
 * One-way write of a span. The pipeline emits a span per stage
 * (safety-gate, router, retrieval, rerank, synthesis, tool-call). Traces
 * are the substrate for the eval harness and for shop-staff conversation
 * review.
 *
 * Assumes:
 * - Sinks are best-effort — a sink failure MUST NOT fail the parent
 *   request. Implementations should log and swallow.
 * - Timestamps are ISO-8601 UTC strings; durations are milliseconds.
 * - PII redaction happens before this port. The sink does not scan.
 */
export type SpanKind =
  | 'safety-gate'
  | 'router'
  | 'retrieval'
  | 'rerank'
  | 'synthesis'
  | 'tool-call'
  | 'refusal';

/**
 * JSON-shaped value type for span attributes. Widened from the
 * original scalar-only shape (2026-09-17, Sprint 3 Story 4) so
 * tool spans can carry structured args + result payloads per
 * ADR-0016 §6. The underlying storage (Supabase `traces.attributes`
 * JSONB column) has always accepted nested structures; the type
 * was overly restrictive.
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | null
  | readonly SpanAttributeValue[]
  | { readonly [key: string]: SpanAttributeValue };

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
  readonly error?: string;
}

export interface TraceSink {
  record(span: Span): Promise<void>;
}
