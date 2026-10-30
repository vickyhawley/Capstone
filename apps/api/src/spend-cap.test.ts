import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  type DailySpendCap,
  createDailySpendCapMiddleware,
  degradedFallbackResponse,
} from './spend-cap.js';

function fakeCap(capCents: number, initialTotal = 0): DailySpendCap & { totalCents: number } {
  const state = { totalCents: initialTotal };
  return {
    capCents,
    get totalCents() {
      return state.totalCents;
    },
    async chargeCents(cents: number) {
      state.totalCents += cents;
      return state.totalCents;
    },
  };
}

describe('createDailySpendCapMiddleware', () => {
  it('passes through when cap is null (dev without env set)', async () => {
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(null));
    app.get('/api/answer', (c) => c.text('ok'));
    const res = await app.request('/api/answer');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('does not charge /api/about', async () => {
    const cap = fakeCap(100);
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    app.get('/api/about', (c) => c.text('ok'));
    await app.request('/api/about');
    expect(cap.totalCents).toBe(0);
  });

  it('does not charge /api/health', async () => {
    const cap = fakeCap(100);
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    app.get('/api/health', (c) => c.text('ok'));
    await app.request('/api/health');
    expect(cap.totalCents).toBe(0);
  });

  it('charges /api/answer and passes through below cap', async () => {
    const cap = fakeCap(100);
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    app.post('/api/answer', (c) => c.json({ answer: 'real' }));
    const res = await app.request('/api/answer', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(cap.totalCents).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ answer: 'real' });
  });

  it('short-circuits with degraded_fallback when the cap trips', async () => {
    const cap = fakeCap(2, /* initialTotal */ 1); // next charge pushes to >= cap
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    let handlerRan = false;
    app.post('/api/answer', (c) => {
      handlerRan = true;
      return c.json({ answer: 'should-not-see' });
    });
    const res = await app.request('/api/answer', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-daily-cap-tripped')).toBe('true');
    const body = (await res.json()) as { degraded_reason?: string; answer?: string };
    expect(body.degraded_reason).toBe('daily-cap-tripped');
    expect(body.answer).toContain('NFCS');
    expect(handlerRan).toBe(false);
  });

  it('also gates /api/answer/stream (prefix match)', async () => {
    const cap = fakeCap(2, 1);
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    app.get('/api/answer/stream', (c) => c.text('should-not-see'));
    const res = await app.request('/api/answer/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-daily-cap-tripped')).toBe('true');
  });

  it('fails open when the counter throws (Redis unreachable)', async () => {
    const cap: DailySpendCap = {
      capCents: 100,
      async chargeCents() {
        throw new Error('redis boom');
      },
    };
    const app = new Hono();
    app.use('*', createDailySpendCapMiddleware(cap));
    app.post('/api/answer', (c) => c.text('ok'));
    const res = await app.request('/api/answer', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('degradedFallbackResponse', () => {
  it('matches the AnswerResponse shape (minimal valid fields)', () => {
    const body = degradedFallbackResponse();
    expect(body).toMatchObject({
      answer: expect.any(String),
      citations: [],
      retrieved_chunk_ids: [],
      behavior: 'answer',
      tool_calls: [],
      product_links: [],
      degraded_reason: 'daily-cap-tripped',
    });
  });
});
