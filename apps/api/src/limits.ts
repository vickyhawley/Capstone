/**
 * Per-request iteration bound.
 *
 * Guards any loop in the pipeline (planner iterations, streamed chunks,
 * tool-call retries). Sized generously — the real ceiling is the time
 * budget below, not this counter — but a hard integer bound exists so a
 * runaway loop can never produce unbounded steps even if a clock is wrong.
 */
export const MAX_ITERATIONS = 32;

/**
 * Per-request wall-clock budget in milliseconds.
 *
 * Sized well below Vercel's default 300 s function duration, and well
 * below the ~60 s streaming keep-alive most CDNs enforce, so a slow
 * request yields a graceful timeout with a partial trace rather than a
 * platform-level kill mid-stream. Sprint 1 may reduce this per-endpoint.
 */
export const TIME_BUDGET_MS = 25_000;

/**
 * Returns an AbortSignal that aborts when either the parent signal aborts
 * or the time budget elapses, whichever comes first.
 */
export function withTimeBudget(
  parent: AbortSignal,
  budgetMs: number = TIME_BUDGET_MS,
): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('time-budget-exceeded'));
  }, budgetMs);

  if (parent.aborted) {
    clearTimeout(timer);
    controller.abort(parent.reason);
  } else {
    parent.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        controller.abort(parent.reason);
      },
      { once: true },
    );
  }

  return controller.signal;
}
