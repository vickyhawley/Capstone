import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { MiddlewareHandler } from 'hono';

/**
 * Per-IP rate limiter contract.
 *
 * Kept interface-shaped so tests inject an in-memory fake and the middleware
 * itself never talks to Redis under test.
 */
export interface RateLimiter {
  limit(identifier: string): Promise<RateLimitResult>;
}

export interface RateLimitResult {
  readonly success: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_WINDOW = '1 m';
const SKIP_PATHS = new Set(['/health', '/api/health']);

/**
 * Constructs a real Upstash-backed limiter. Returns null if env vars are
 * absent, so local dev without Upstash configured is permit-all — but see
 * `assertLimiterOrFail` for the prod safety net.
 *
 * Accepts either the raw Upstash names (`UPSTASH_REDIS_REST_URL/TOKEN`) or
 * Vercel's normalized KV names (`KV_REST_API_URL/TOKEN`). Vercel's Upstash
 * Marketplace integration only injects the `KV_*` shape.
 */
export function createRedisRateLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter | null {
  const url = env['UPSTASH_REDIS_REST_URL'] ?? env['KV_REST_API_URL'];
  const token = env['UPSTASH_REDIS_REST_TOKEN'] ?? env['KV_REST_API_TOKEN'];
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(DEFAULT_LIMIT, DEFAULT_WINDOW),
    analytics: false,
    prefix: 'gw:rl',
  });

  return {
    async limit(identifier: string) {
      const r = await rl.limit(identifier);
      return { success: r.success, limit: r.limit, remaining: r.remaining, reset: r.reset };
    },
  };
}

/**
 * Fail-closed in production: if the LanguageModel adapter ever ships without
 * a real rate limiter behind it, the server refuses to boot. Dev keeps
 * permit-all so local iteration doesn't require a Redis account.
 */
export function assertLimiterOrFail(
  limiter: RateLimiter | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (limiter) return;
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      'Rate limiter not configured. Set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (or Vercel-provisioned KV_REST_API_URL/KV_REST_API_TOKEN) in production.',
    );
  }
}

/**
 * Middleware. Skips `/health` and `/api/health`; rate-limits everything else
 * by client IP. Returns 429 with `Retry-After` when the bucket is exhausted.
 *
 * IP source order:
 *   1. `x-real-ip` (Vercel sets this and it can't be forged by the client).
 *   2. First entry of `x-forwarded-for` (for non-Vercel deploys).
 *   3. `unknown` (local dev where no proxy is in front).
 *
 * The `unknown` bucket is shared across all local requests. That's fine —
 * this middleware exists to bound spend on a public unauthenticated
 * endpoint, and local dev is neither public nor spending real money.
 */
export function createRateLimitMiddleware(limiter: RateLimiter | null): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_PATHS.has(c.req.path)) return next();
    if (!limiter) return next();

    const ip = resolveClientIp(c.req.header('x-real-ip'), c.req.header('x-forwarded-for'));
    const result = await limiter.limit(ip);
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.reset));
    if (!result.success) {
      const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json({ error: 'rate-limited', retryAfterSec }, 429);
    }
    return next();
  };
}

export function resolveClientIp(
  realIp: string | undefined,
  forwardedFor: string | undefined,
): string {
  if (realIp) return realIp;
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
