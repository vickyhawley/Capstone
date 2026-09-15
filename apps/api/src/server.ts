import { RulesSafetyGate } from '@groundwork/adapters';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createAboutRoute } from './about.js';
import { createAnswerRoute, defaultAnswerDeps } from './answer.js';
import { MAX_ITERATIONS, TIME_BUDGET_MS, withTimeBudget } from './limits.js';
import {
  assertLimiterOrFail,
  createRateLimitMiddleware,
  createRedisRateLimiter,
} from './rate-limit.js';

const limiter = createRedisRateLimiter();
assertLimiterOrFail(limiter);

let answerDepsCache: ReturnType<typeof defaultAnswerDeps> | null = null;
function getAnswerDeps() {
  answerDepsCache ??= defaultAnswerDeps();
  return answerDepsCache;
}

export const app = new Hono();

// Rate limit first so a hostile client can't run any handler for free.
app.use('*', createRateLimitMiddleware(limiter));

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'groundwork-api',
    version: '0.0.1',
    limits: { maxIterations: MAX_ITERATIONS, timeBudgetMs: TIME_BUDGET_MS },
    rateLimit: { configured: limiter !== null },
  }),
);

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    service: 'groundwork-api',
    version: '0.0.1',
    limits: { maxIterations: MAX_ITERATIONS, timeBudgetMs: TIME_BUDGET_MS },
    rateLimit: { configured: limiter !== null },
  }),
);

/**
 * SSE smoke test.
 *
 * Emits up to `MAX_ITERATIONS` `token` events on a short interval, then a
 * terminating `done` event. Exists to prove end-to-end streaming through
 * the Vercel rewrite before Sprint 1 wires the real synthesis stream.
 */
app.get('/api/stream/demo', (c) => {
  return streamSSE(c, async (stream) => {
    const parent = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => parent.abort(), { once: true });
    const signal = withTimeBudget(parent.signal);

    const started = Date.now();
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal.aborted) break;
      await stream.writeSSE({
        event: 'token',
        data: JSON.stringify({ i, elapsedMs: Date.now() - started, text: `chunk ${i}` }),
      });
      await stream.sleep(150);
    }

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({ reason: signal.aborted ? 'aborted' : 'complete' }),
    });
  });
});

// GET /api/about — Article 50 disclosure + capability profile. ADR-0012.
// Public info; rides the shared rate-limit middleware.
app.route('/api/about', createAboutRoute());

// POST /api/answer — Sprint 2 shape (GW-10 + GW-11 landed).
// Route is registered once; deps are built lazily on first request
// inside the handler so a missing OPENAI_API_KEY produces a 500 with
// a clear message rather than an import-time crash the deploy log
// buries. The safety gate has no async construction cost so it's
// built once eagerly.
const eagerSafetyGate = new RulesSafetyGate();
app.route(
  '/api/answer',
  createAnswerRoute({
    router: {
      async route(query) {
        const deps = getAnswerDeps();
        return deps.router.route(query);
      },
    },
    safetyGate: eagerSafetyGate,
  }),
);
