/**
 * POST /api/answer — the endpoint the eval harness hits.
 *
 * Sprint 2 shape (GW-10 + GW-11 landed, retrieval/synthesis pending):
 * runs the intent router, then the safety gate, and returns both
 * decisions in the response. `answer` / `citations` /
 * `retrieved_chunk_ids` are populated only when the gate returns
 * `answer` and downstream retrieval/synthesis lands (Sprint 2+).
 *
 * The response schema matches `evals/groundwork_evals/schema.py`
 * `ApiResponse` — that Python file is the source of truth per
 * ADR-0010 and ADR-0011.
 *
 * Runtime dependency: OPENAI_API_KEY. The router's LLM classifier
 * needs it; the endpoint fails cleanly with a 500 if it's missing
 * rather than instantiating a broken client at import time.
 */

import { HybridRouter, RulesSafetyGate } from '@groundwork/adapters';
import type { Behaviour, Router, SafetyGate } from '@groundwork/core';
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
  readonly behavior: 'answer' | 'abstain' | 'escalate';
  readonly escalation_target: string | null;
}

export interface AnswerDeps {
  readonly router: Router;
  readonly safetyGate: SafetyGate;
}

/**
 * Build the /api/answer route. Dependencies are injected so tests can
 * pass a StubRouter + stub gate and skip the OpenAI network call.
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

    const query = { text: body.query };

    let decision: Awaited<ReturnType<Router['route']>>;
    try {
      decision = await deps.router.route(query);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }

    const behaviour = deps.safetyGate.decide(decision, query);

    const response: AnswerResponseBody = {
      answer: '',
      citations: [],
      retrieved_chunk_ids: [],
      refusal_reason: behaviour.kind === 'abstain' ? behaviour.refusalReason : null,
      trace_id: null,
      intent: decision.intent,
      adversarial_suspected: decision.adversarialSuspected,
      adversarial_pattern: decision.adversarialPattern ?? null,
      behavior: behaviour.kind,
      escalation_target: escalationTargetOf(behaviour),
    };
    return c.json(response);
  });

  return route;
}

function escalationTargetOf(b: Behaviour): string | null {
  return b.kind === 'escalate' ? b.escalationTarget : null;
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
  return {
    router: new HybridRouter(openai),
    safetyGate: new RulesSafetyGate(),
  };
}
