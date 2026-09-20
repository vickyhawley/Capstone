/**
 * Unit tests for CircuitBreaker. GW-23 (2026-09-18).
 *
 * Covers the state machine (closed → open on threshold → half-open
 * on cooldown → closed on probe-success or re-open on probe-fail),
 * the fail-fast behaviour when open, counter reset on success, and
 * the observability `currentState()` reflecting the passive
 * cooldown-expiry transition.
 */
import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

interface FakeClock {
  readonly now: () => number;
  advance(ms: number): void;
}

function fakeClock(startAt = 1_000_000): FakeClock {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CircuitBreaker', () => {
  describe('closed state', () => {
    it('passes through successful calls', async () => {
      const cb = new CircuitBreaker('openai', { failureThreshold: 3, cooldownMs: 1000 });
      const result = await cb.run(async () => 'ok');
      expect(result).toBe('ok');
      expect(cb.currentState()).toBe('closed');
    });

    it('re-throws the wrapped fn error and increments the counter', async () => {
      const cb = new CircuitBreaker('openai', { failureThreshold: 3, cooldownMs: 1000 });
      await expect(cb.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      expect(cb.currentState()).toBe('closed');
    });

    it('resets the counter on any success', async () => {
      // 2 failures + 1 success + 2 failures + 1 success + 2 failures ≠ open,
      // because the counter is CONSECUTIVE not total.
      const cb = new CircuitBreaker('openai', { failureThreshold: 3, cooldownMs: 1000 });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await cb.run(async () => 'ok');
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('closed');
    });
  });

  describe('opening', () => {
    it('opens after N consecutive failures', async () => {
      const cb = new CircuitBreaker('openai', { failureThreshold: 3, cooldownMs: 1000 });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('closed');
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('open');
    });

    it('throws CircuitOpenError once open, WITHOUT invoking the wrapped fn', async () => {
      const cb = new CircuitBreaker('supabase', { failureThreshold: 2, cooldownMs: 1000 });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('open');

      let called = false;
      const err = await cb.run(async () => {
        called = true;
        return 'never';
      }).catch((e: unknown) => e);
      expect(called).toBe(false);
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).circuitName).toBe('supabase');
    });
  });

  describe('cooldown → half-open → closed/open', () => {
    it('transitions open → half-open after cooldown elapses', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker('openai', {
        failureThreshold: 2,
        cooldownMs: 500,
        clock: clock.now,
      });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('open');
      clock.advance(499);
      expect(cb.currentState()).toBe('open');
      clock.advance(1);
      // Cooldown boundary reached (>=). Observable state reports
      // half-open passively before any run() call.
      expect(cb.currentState()).toBe('half-open');
    });

    it('half-open probe success closes the circuit and resets the counter', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker('openai', {
        failureThreshold: 2,
        cooldownMs: 500,
        clock: clock.now,
      });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      clock.advance(500);
      const result = await cb.run(async () => 'probe-ok');
      expect(result).toBe('probe-ok');
      expect(cb.currentState()).toBe('closed');
      // Counter was reset — one more failure should NOT re-open.
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.currentState()).toBe('closed');
    });

    it('half-open probe failure re-opens with a fresh cooldown', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker('openai', {
        failureThreshold: 2,
        cooldownMs: 500,
        clock: clock.now,
      });
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      clock.advance(500);
      // Half-open probe fails → re-open. Any consecutive-failure
      // count doesn't matter here — the half-open branch opens on
      // first failure by design.
      await expect(cb.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
      expect(cb.currentState()).toBe('open');
      // Cooldown restarted from the re-open, not the original open.
      clock.advance(499);
      expect(cb.currentState()).toBe('open');
      clock.advance(1);
      expect(cb.currentState()).toBe('half-open');
    });
  });
});
