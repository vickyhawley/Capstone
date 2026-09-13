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

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly error?: string;
}

export interface TraceSink {
  record(span: Span): Promise<void>;
}
