import { RouteBasedPlanner, RulesSafetyGate } from '@groundwork/adapters';
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

// `defaultAnswerDeps` is async since GW-20 (ProductStockLookupTool)
// loads two YAML files at startup. Cache the promise so concurrent
// first-hit requests all await the same resolution rather than
// racing to build competing dep sets.
let answerDepsPromise: ReturnType<typeof defaultAnswerDeps> | null = null;
function getAnswerDeps() {
  answerDepsPromise ??= defaultAnswerDeps();
  return answerDepsPromise;
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

// POST /api/answer — Sprint 3 shape (GW-10, GW-11, GW-12, GW-18,
// GW-20, GW-25 landed). Route is registered once; env-dependent and
// I/O-dependent deps are built lazily on first request inside their
// proxies so a missing var or corrupt YAML surfaces as a 500 with a
// clear message rather than an import-time crash the deploy log
// buries. The router needs OPENAI_API_KEY; the SupabaseTraceSink
// (GW-25) needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY;
// ProductStockLookupTool (GW-20) loads two YAML files at startup.
// Non-env-dependent deps are built once eagerly.
const eagerSafetyGate = new RulesSafetyGate();
// Sprint 4: RouteBasedPlanner replaces NoopPlanner so the three
// Sprint-3 tools actually fire on real requests (Tier-1 dispatch
// per ADR-0014). Stateless — safe to construct once at import time.
const eagerPlanner = new RouteBasedPlanner();
app.route(
  '/api/answer',
  createAnswerRoute({
    router: {
      async route(query) {
        return (await getAnswerDeps()).router.route(query);
      },
    },
    safetyGate: eagerSafetyGate,
    planner: eagerPlanner,
    toolRegistry: {
      // `list()` on the ToolRegistry port is synchronous and is not
      // yet called from any code path (as of Sprint 3 Story 4). When
      // a real planner starts consuming it (GW-24), the composition
      // root will need to await deps up front — return [] here so
      // the proxy honours the interface contract meanwhile.
      list() {
        return [];
      },
      async invoke(call, signal) {
        return (await getAnswerDeps()).toolRegistry.invoke(call, signal);
      },
    },
    traceSink: {
      async record(span) {
        return (await getAnswerDeps()).traceSink.record(span);
      },
    },
  }),
);
