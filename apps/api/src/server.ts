import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MAX_ITERATIONS, TIME_BUDGET_MS, withTimeBudget } from './limits.js';
import {
  assertLimiterOrFail,
  createRateLimitMiddleware,
  createRedisRateLimiter,
} from './rate-limit.js';

const limiter = createRedisRateLimiter();
assertLimiterOrFail(limiter);

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
