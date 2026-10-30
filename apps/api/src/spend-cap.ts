/**
 * Daily spend cap.
 *
 * Soft safety net on top of the per-IP rate limiter. The rate limiter
 * bounds abuse; this bounds total spend across all users on a given
 * UTC day. When the counter crosses `DAILY_SPEND_CAP_USD`, every
 * subsequent /api/answer request returns a 200 carrying the standard
 * degraded_fallback copy instead of invoking the pipeline.
 *
 * Unit: USD cents, stored as a Redis integer counter keyed on UTC
 * date. The counter is incremented by a *conservative per-request
 * estimate* before the pipeline runs — see GW-24. Real per-call
 * token usage isn't collected end-to-end yet (the SupabaseTraceSink
 * header reserves the attribute keys but nothing writes them). Once
 * GW-24 lands, swap `PER_REQUEST_ESTIMATED_CENTS` for a post-hoc
 * `incrementBy(actualCents)` call and this module stops being an
 * estimate.
 *
 * Fail-posture: if Upstash is unreachable at check time, we FAIL
 * OPEN. The alternative (fail-closed) would let a Redis outage take
 * out the chat for everyone; a short window of over-spend is less
 * bad than a hard outage on a budget cap whose own precision is
 * ±50%.
 */
import { DEGRADED_FALLBACK } from '@groundwork/core';
import { Redis } from '@upstash/redis';
import type { MiddlewareHandler } from 'hono';

export interface DailySpendCap {
  /**
   * Increment today's counter by the given cents and return the new
   * total. Callers use the returned total to decide trip vs. pass.
   */
  chargeCents(cents: number): Promise<number>;
  readonly capCents: number;
}

/**
 * GW-24 — Replace with real per-call token usage once the language
 * model port surfaces usage. For now, a conservative floor estimate:
 * roughly 10K input + 2K output tokens per /api/answer turn at
 * cheap-tier prices (~$0.0005/1K input, ~$0.0015/1K output) ≈
 * $0.008/turn. We round up to 1.5¢ to leave headroom for the planner,
 * tool-use loops, and the embedding call. Over-estimates make the
 * cap trip slightly early, which is the safe direction.
 */
const PER_REQUEST_ESTIMATED_CENTS = 2;

function todayUtcKey(now: Date = new Date()): string {
  return `gw:spend:${now.toISOString().slice(0, 10)}`;
}

/**
 * Three-day TTL on the daily counter. Longer than needed, short
 * enough that abandoned keys don't accumulate forever. A tighter TTL
 * risks the key expiring mid-day near UTC midnight if clocks drift.
 */
const COUNTER_TTL_SEC = 60 * 60 * 24 * 3;

function parseCapDollars(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `DAILY_SPEND_CAP_USD must be a positive finite number (got "${raw}").`,
    );
  }
  return n;
}

export function createRedisDailySpendCap(
  env: NodeJS.ProcessEnv = process.env,
): DailySpendCap | null {
  const url = env['UPSTASH_REDIS_REST_URL'] ?? env['KV_REST_API_URL'];
  const token = env['UPSTASH_REDIS_REST_TOKEN'] ?? env['KV_REST_API_TOKEN'];
  if (!url || !token) return null;

  const capDollars = parseCapDollars(env['DAILY_SPEND_CAP_USD']);
  if (capDollars === null) return null;

  const capCents = Math.round(capDollars * 100);
  const redis = new Redis({ url, token });

  return {
    capCents,
    async chargeCents(cents: number): Promise<number> {
      const key = todayUtcKey();
      const total = await redis.incrby(key, cents);
      // Fire-and-forget EXPIRE — don't block on the TTL extension; if
      // it fails we'll just orphan the key for a day. Any thrown
      // error here would otherwise block the request.
      void redis.expire(key, COUNTER_TTL_SEC).catch(() => undefined);
      return total;
    },
  };
}

/**
 * Response body the API hands back on trip. Matches the
 * AnswerResponse shape expected by the web client — minimal valid
 * values for the mandatory fields; the client reads `answer` and
 * `degraded_reason` and ignores the rest when degraded.
 */
export function degradedFallbackResponse(): Record<string, unknown> {
  return {
    answer: DEGRADED_FALLBACK,
    citations: [],
    retrieved_chunk_ids: [],
    refusal_reason: null,
    trace_id: null,
    intent: null,
    adversarial_suspected: false,
    adversarial_pattern: null,
    product_query: null,
    behavior: 'answer',
    escalation_target: null,
    tool_calls: [],
    substitute_handles: [],
    delivery_zone_status: null,
    product_links: [],
    conversation_id: null,
    rewritten_query: null,
    degraded_reason: 'daily-cap-tripped',
  };
}

const PROTECTED_PATH_PREFIXES = ['/api/answer'];

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Middleware factory. Pre-charges the day's counter by the
 * conservative estimate before the pipeline runs; if the resulting
 * total crosses the cap, short-circuits with the degraded_fallback
 * body. Non-/api/answer paths (health, about) pass through — only
 * the LLM-costly surfaces are gated.
 *
 * Streaming note: /api/answer/stream is covered by the prefix check
 * but a tripped stream currently emits a JSON body, not an SSE
 * sequence. The browser's streamAnswer client will throw on the
 * mismatch and the Chat UI already renders the "Couldn't reach the
 * assistant" fallback — acceptable for a cap trip but worth
 * upgrading to a single SSE `done` event once GW-24 lands.
 */
export function createDailySpendCapMiddleware(cap: DailySpendCap | null): MiddlewareHandler {
  return async (c, next) => {
    if (!cap) return next();
    if (!isProtectedPath(c.req.path)) return next();

    let total: number;
    try {
      total = await cap.chargeCents(PER_REQUEST_ESTIMATED_CENTS);
    } catch (err) {
      // Fail open — see module header. Still log loudly so the
      // outage is visible in traces.
      console.error('[spend-cap] charge failed, failing open:', (err as Error).message);
      return next();
    }

    if (total >= cap.capCents) {
      c.header('X-Daily-Cap-Tripped', 'true');
      return c.json(degradedFallbackResponse(), 200);
    }

    return next();
  };
}
