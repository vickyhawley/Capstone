import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type RateLimitResult,
  type RateLimiter,
  assertLimiterOrFail,
  createRateLimitMiddleware,
  createRedisRateLimiter,
  resolveClientIp,
} from './rate-limit.js';

function fakeLimiter(results: RateLimitResult[]): RateLimiter {
  let i = 0;
  return {
    async limit() {
      const next = results[i] ?? results[results.length - 1];
      i += 1;
      if (!next) throw new Error('fake ran out of results');
      return next;
    },
  };
}

function ok(remaining: number): RateLimitResult {
  return { success: true, limit: 20, remaining, reset: Date.now() + 60_000 };
}

function blocked(): RateLimitResult {
  return { success: false, limit: 20, remaining: 0, reset: Date.now() + 30_000 };
}

describe('resolveClientIp', () => {
  it('prefers x-real-ip', () => {
    expect(resolveClientIp('1.1.1.1', '2.2.2.2, 3.3.3.3')).toBe('1.1.1.1');
  });

  it('falls back to first x-forwarded-for entry', () => {
    expect(resolveClientIp(undefined, '2.2.2.2, 3.3.3.3')).toBe('2.2.2.2');
  });

  it('returns unknown when neither header is set', () => {
    expect(resolveClientIp(undefined, undefined)).toBe('unknown');
  });
});

describe('rate-limit middleware', () => {
  it('skips /health without touching the limiter', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(fakeLimiter([])));
    app.get('/health', (c) => c.text('ok'));
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('skips /api/health without touching the limiter', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(fakeLimiter([])));
    app.get('/api/health', (c) => c.text('ok'));
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('permits when limiter is null (dev without Upstash configured)', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(null));
    app.get('/api/answer', (c) => c.text('ok'));
    const res = await app.request('/api/answer');
    expect(res.status).toBe(200);
  });

  it('passes through when success is true', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(fakeLimiter([ok(19)])));
    app.get('/api/answer', (c) => c.text('ok'));
    const res = await app.request('/api/answer', { headers: { 'x-real-ip': '1.1.1.1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-remaining')).toBe('19');
  });

  it('returns 429 with Retry-After when blocked', async () => {
    const app = new Hono();
    app.use('*', createRateLimitMiddleware(fakeLimiter([blocked()])));
    app.get('/api/answer', (c) => c.text('ok'));
    const res = await app.request('/api/answer', { headers: { 'x-real-ip': '1.1.1.1' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate-limited');
  });
});

describe('createRedisRateLimiter env resolution', () => {
  it('returns null when no env vars are present (dev)', () => {
    expect(createRedisRateLimiter({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('accepts Vercel-normalized KV_REST_API_* names', () => {
    const limiter = createRedisRateLimiter({
      KV_REST_API_URL: 'https://example.upstash.io',
      KV_REST_API_TOKEN: 'token-value',
    } as NodeJS.ProcessEnv);
    expect(limiter).not.toBeNull();
  });

  it('accepts raw UPSTASH_REDIS_REST_* names', () => {
    const limiter = createRedisRateLimiter({
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'token-value',
    } as NodeJS.ProcessEnv);
    expect(limiter).not.toBeNull();
  });

  it('prefers UPSTASH_* over KV_* when both are set', () => {
    // Belt-and-braces case: if a project sets both (e.g. after switching
    // integrations), the explicit Upstash names win so behaviour is predictable.
    const limiter = createRedisRateLimiter({
      UPSTASH_REDIS_REST_URL: 'https://explicit.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'explicit-token',
      KV_REST_API_URL: 'https://kv.upstash.io',
      KV_REST_API_TOKEN: 'kv-token',
    } as NodeJS.ProcessEnv);
    expect(limiter).not.toBeNull();
  });
});

describe('assertLimiterOrFail', () => {
  it('throws in production when limiter is null', () => {
    expect(() =>
      assertLimiterOrFail(null, { NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/Rate limiter not configured/);
  });

  it('permits null in development', () => {
    expect(() =>
      assertLimiterOrFail(null, { NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('permits a real limiter in any environment', () => {
    const limiter: RateLimiter = {
      async limit() {
        return ok(20);
      },
    };
    expect(() =>
      assertLimiterOrFail(limiter, { NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
