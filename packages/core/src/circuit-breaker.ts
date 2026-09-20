/**
 * Circuit breaker. GW-23 (2026-09-18 — fourth of the four Sprint-3
 * close-scope stories).
 *
 * Wraps an async operation on a named external dependency (openai,
 * supabase, ...). After `failureThreshold` consecutive failures the
 * breaker opens: subsequent `run()` calls throw a `CircuitOpenError`
 * immediately without invoking the wrapped fn. After `cooldownMs`
 * has elapsed the breaker moves to half-open: the next call is
 * allowed through as a probe; on success the breaker closes, on
 * failure it re-opens.
 *
 * Scope discipline (freeze rule "ship the story, run the smoke,
 * record the finding, move on"):
 *
 * - No exponential backoff, no jitter, no per-error-class policies,
 *   no metric emitters beyond `currentState()` — this primitive
 *   exists to convert cascading infra failures into a clean
 *   graceful-escalate at the request boundary, not to be a
 *   general-purpose resilience framework.
 * - "Consecutive failures" not "failures in a rolling window" — a
 *   sliding window would be more accurate but the extra machinery
 *   doesn't buy the customer answer anything at Sprint-3 scale.
 * - Half-open probes call the real fn (no dedicated probe path).
 *   Any live request can be the probe; the caller doesn't know
 *   which one is.
 *
 * Placement: this primitive is in `packages/core` because it has
 * zero external dependencies (no OpenAI, no Supabase, no HTTP) —
 * pure state machine over an async fn. Adapters that hit named
 * dependencies take a `CircuitBreaker` as a constructor dep; the
 * composition root wires one per dependency.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. */
  readonly failureThreshold: number;
  /** Milliseconds the circuit stays open before allowing a half-open probe. */
  readonly cooldownMs: number;
  /** Millisecond clock; overridable for tests. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Thrown by `CircuitBreaker.run()` when the breaker is open. The
 * request handler recognises this as a distinct failure mode from a
 * wrapped-fn throw — both convert to graceful-escalate, but the
 * breaker-open variant lets the trace record that the call was
 * skipped entirely.
 */
export class CircuitOpenError extends Error {
  readonly circuitName: string;

  constructor(circuitName: string) {
    super(`circuit breaker '${circuitName}' is open`);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly clock: () => number;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Invoke `fn` under the breaker. Returns fn's resolved value.
   * Throws `CircuitOpenError` when the circuit is open past the
   * cooldown boundary. Re-throws fn's error on failure (after
   * updating internal state).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Open → half-open transition on cooldown expiry. Do this
    // before the state check so the state field reflects reality
    // for observers reading `currentState()`.
    if (this.state === 'open' && this.openedAt !== null) {
      if (this.clock() - this.openedAt >= this.options.cooldownMs) {
        this.state = 'half-open';
      }
    }

    if (this.state === 'open') {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      // Success: reset counter regardless of state; close if we
      // were probing.
      this.consecutiveFailures = 0;
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.openedAt = null;
      }
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      // Half-open probe failed → re-open with a fresh cooldown.
      // Closed → open if threshold reached.
      if (
        this.state === 'half-open' ||
        this.consecutiveFailures >= this.options.failureThreshold
      ) {
        this.state = 'open';
        this.openedAt = this.clock();
      }
      throw error;
    }
  }

  /** Observability: the state the breaker is in RIGHT NOW. */
  currentState(): CircuitState {
    // Reflect the cooldown-expiry transition without side-effecting
    // (run() will apply it on the next call).
    if (this.state === 'open' && this.openedAt !== null) {
      if (this.clock() - this.openedAt >= this.options.cooldownMs) {
        return 'half-open';
      }
    }
    return this.state;
  }
}
