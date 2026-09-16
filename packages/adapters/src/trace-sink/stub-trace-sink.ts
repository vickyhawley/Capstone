/**
 * StubTraceSink. Silent no-op that satisfies the port contract.
 *
 * The TraceSink port docstring states: "Sinks are best-effort — a
 * sink failure MUST NOT fail the parent request. Implementations
 * should log and swallow." The pre-GW-18 version threw
 * `NotImplementedError` from record, which violated the port
 * contract — any caller emitting a span would kill its request.
 * The tool loop (GW-18) wraps `record()` in a try/catch as
 * defence-in-depth, but a stub sink shouldn't need that
 * protection to behave correctly.
 *
 * Ships as the default sink for /api/answer until GW-25 (trace
 * logging) provides a Supabase-backed implementation that
 * persists spans to a `traces` table for the eval harness and
 * staff console.
 */
import type { Span, TraceSink } from '@groundwork/core';

export class StubTraceSink implements TraceSink {
  async record(_span: Span): Promise<void> {
    // Deliberately silent. Sink port contract is best-effort;
    // the real implementation lands with GW-25.
  }
}
