import { describe, expect, it } from 'vitest';
import { MAX_ITERATIONS, TIME_BUDGET_MS, withTimeBudget } from './limits.js';

describe('limits', () => {
  it('exposes sane defaults', () => {
    expect(MAX_ITERATIONS).toBeGreaterThan(0);
    expect(MAX_ITERATIONS).toBeLessThanOrEqual(64);
    expect(TIME_BUDGET_MS).toBeGreaterThan(1000);
    expect(TIME_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });

  it('withTimeBudget aborts on parent abort', () => {
    const parent = new AbortController();
    const signal = withTimeBudget(parent.signal, 60_000);
    expect(signal.aborted).toBe(false);
    parent.abort(new Error('parent'));
    expect(signal.aborted).toBe(true);
  });

  it('withTimeBudget aborts when budget elapses', async () => {
    const parent = new AbortController();
    const signal = withTimeBudget(parent.signal, 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
  });
});
