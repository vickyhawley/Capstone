/**
 * Per-request iteration bound.
 *
 * Guards any loop in the pipeline (planner iterations, tool-call retries,
 * retrieval passes). Sized so that at realistic per-iteration cost the
 * counter is reachable within the wall-clock budget — otherwise the
 * timeout always fires first and the bound is decorative. See
 * docs/adr/0002-iteration-vs-timeout.md for the sizing argument.
 */
export const MAX_ITERATIONS = 8;

/**
 * Per-request wall-clock budget in milliseconds.
 *
 * Sized well below Vercel's default 300 s function duration, and well
 * below the ~60 s streaming keep-alive most CDNs enforce, so a slow
 * request yields a graceful timeout with a partial trace rather than a
 * platform-level kill mid-stream. Sprint 1 may reduce this per-endpoint.
 * The iteration bound above is the primary stop; this is the safety net.
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
