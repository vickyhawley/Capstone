/**
 * POST /api/answer — the endpoint the eval harness hits.
 *
 * Sprint 2 shape (GW-10 landed, GW-11 pending): runs the intent
 * router and returns the router decision plus placeholder empty
 * fields for the answer path that GW-11 + retrieval synthesis will
 * fill in later.
 *
 * The response schema matches `evals/groundwork_evals/schema.py`
 * `ApiResponse` — that Python file is the source of truth per
 * ADR-0010. Fields the Python side does not require are still
 * populated with sensible empties so a Sprint 3 consumer that
 * expects the full shape does not have to special-case Sprint 2.
 *
 * Runtime dependency: OPENAI_API_KEY. The router's LLM classifier
 * needs it; the endpoint fails cleanly with a 500 if it's missing
 * rather than instantiating a broken client at import time.
 */

import { HybridRouter } from '@groundwork/adapters';
import type { Router } from '@groundwork/core';
import { Hono } from 'hono';
import OpenAI from 'openai';

interface AnswerRequestBody {
  readonly query?: unknown;
  readonly conversation_id?: unknown;
}

interface AnswerResponseBody {
  readonly answer: string;
  readonly citations: readonly never[];
  readonly retrieved_chunk_ids: readonly string[];
  readonly refusal_reason: string | null;
  readonly trace_id: string | null;
  readonly intent: string;
  readonly adversarial_suspected: boolean;
  readonly adversarial_pattern: string | null;
}

export interface AnswerDeps {
  readonly router: Router;
}

/**
 * Build the /api/answer route. Dependencies are injected so tests can
 * pass a StubRouter and skip the OpenAI network call.
 */
export function createAnswerRoute(deps: AnswerDeps): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let body: AnswerRequestBody;
    try {
      body = (await c.req.json()) as AnswerRequestBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.query !== 'string' || body.query.trim() === '') {
      return c.json({ error: '`query` is required and must be a non-empty string' }, 400);
    }

    let decision: Awaited<ReturnType<Router['route']>>;
    try {
      decision = await deps.router.route({ text: body.query });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }

    const response: AnswerResponseBody = {
      answer: '',
      citations: [],
      retrieved_chunk_ids: [],
      refusal_reason: null,
      trace_id: null,
      intent: decision.intent,
      adversarial_suspected: decision.adversarialSuspected,
      adversarial_pattern: decision.adversarialPattern ?? null,
    };
    return c.json(response);
  });

  return route;
}

/**
 * Instantiate the default production dependencies from env. Called
 * from `server.ts` at request-scope so a missing key produces a 500
 * on the first hit rather than an import-time crash.
 */
export function defaultAnswerDeps(): AnswerDeps {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for /api/answer');
  }
  const openai = new OpenAI({ apiKey });
  return { router: new HybridRouter(openai) };
}
