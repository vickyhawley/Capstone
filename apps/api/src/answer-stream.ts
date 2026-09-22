/**
 * POST /api/answer/stream — SSE variant of /api/answer.
 *
 * Same pipeline as the JSON route (router → gate → tool loop →
 * synthesizer) but emits Server-Sent Events as it progresses:
 *
 *   event: tool-start       — a tool call is about to fire
 *   event: tool-complete    — a tool call returned
 *   event: answer-delta     — a chunk of the answer text
 *   event: done             — final metadata + terminal
 *
 * The JSON route stays as-is so the Python eval harness keeps
 * working. This route is the UI surface: browsers use fetch +
 * ReadableStream to consume the event stream.
 *
 * Failure handling mirrors GW-23: any thrown exception during the
 * request is caught at the boundary and emitted as a `done` event
 * with `behavior: 'escalate'`, `escalation_target: 'staff-order'`,
 * and a `degraded_reason` field. The connection closes cleanly
 * (no 500) so the client can render the graceful-escalate answer.
 */

import type { Behaviour, RouterQuery, Synthesizer } from '@groundwork/core';
import { renderBehaviour, runToolLoop } from '@groundwork/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { AnswerDeps } from './answer.js';
import { MAX_ITERATIONS, TIME_BUDGET_MS } from './limits.js';
import {
  extractCitations,
  extractDeliveryZoneStatus,
  extractProductLinks,
  extractRetrievedChunkIds,
  extractSubstituteHandles,
  generateTraceId,
} from './tool-output.js';

interface AnswerRequestBody {
  readonly query?: unknown;
  readonly conversation_id?: unknown;
}

/**
 * Build the streaming route. Same deps as the JSON route; the
 * shape they use is identical (router + gate + planner +
 * toolRegistry + traceSink + synthesizer). The synthesizer's
 * `synthesizeStream()` method is the one that fires here; the
 * non-streaming `synthesize()` is unused on this path.
 */
export function createAnswerStreamRoute(deps: AnswerDeps): Hono {
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
    const originalQueryText = body.query;
    const clientConvId = typeof body.conversation_id === 'string' ? body.conversation_id : null;

    return streamSSE(c, async (stream) => {
      let conversationId: string | null = null;
      let originalUserText = originalQueryText;
      let finalAssistantText = '';
      try {
        // GW-16: load-or-create conversation, then rewrite the
        // ambiguous follow-up (if any) before the router sees it.
        // Same semantics as the JSON route — see answer.ts for
        // full rationale.
        let history: readonly import('@groundwork/core').ConversationTurn[] = [];
        if (deps.conversationStore) {
          if (clientConvId) {
            const existing = await deps.conversationStore.get(clientConvId);
            if (existing) {
              conversationId = existing.id;
              history = existing.history;
            }
          }
          if (!conversationId) {
            const fresh = await deps.conversationStore.create();
            conversationId = fresh.id;
          }
        }
        const routerQueryText =
          history.length > 0 && deps.contextRewriter
            ? await deps.contextRewriter(originalQueryText, history)
            : originalQueryText;
        const rewritten = routerQueryText !== originalQueryText ? routerQueryText : null;
        const query: RouterQuery = { text: routerQueryText };

        const decision = await deps.router.route(query);
        const behaviour = deps.safetyGate.decide(decision, query);
        const behaviourCopy = renderBehaviour(behaviour);

        // For non-answer behaviours (escalate / abstain), the safety
        // gate's copy is the answer. Emit it as a single delta so
        // clients that build up text incrementally get it the same
        // way as the streaming case, then close with done.
        if (behaviour.kind !== 'answer') {
          if (behaviourCopy) {
            await stream.writeSSE({
              event: 'answer-delta',
              data: JSON.stringify({ text: behaviourCopy }),
            });
          }
          finalAssistantText = behaviourCopy ?? '';
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              trace_id: null,
              intent: decision.intent,
              adversarial_suspected: decision.adversarialSuspected,
              adversarial_pattern: decision.adversarialPattern ?? null,
              product_query: decision.productQuery ?? null,
              behavior: behaviour.kind,
              escalation_target: escalationTargetOf(behaviour),
              refusal_reason:
                behaviour.kind === 'abstain' ? behaviour.refusalReason : null,
              tool_calls: [],
              substitute_handles: [],
              delivery_zone_status: null,
              product_links: [],
              citations: [],
              retrieved_chunk_ids: [],
              conversation_id: conversationId,
              rewritten_query: rewritten,
              degraded_reason: null,
            }),
          });
          // Fall through to the finally block so the turn is
          // still persisted to the conversation history.
          return;
        }

        // Answer branch: run tool loop, emit per-tool events, then
        // stream synth deltas, then done with metadata.
        const traceId = generateTraceId();
        const invocationEvents: Array<{
          readonly name: string;
          readonly args: Readonly<Record<string, unknown>>;
          readonly ok: boolean;
          readonly duration_ms: number;
        }> = [];

        const loopResult = await runToolLoop(
          {
            planner: deps.planner,
            toolRegistry: {
              list: () => deps.toolRegistry.list(),
              // Wrap invoke so we can emit tool-start/complete
              // events for each call without duplicating the loop.
              invoke: async (call, signal) => {
                await stream.writeSSE({
                  event: 'tool-start',
                  data: JSON.stringify({ name: call.name, args: call.args }),
                });
                const start = Date.now();
                const result = await deps.toolRegistry.invoke(call, signal);
                const duration = Date.now() - start;
                await stream.writeSSE({
                  event: 'tool-complete',
                  data: JSON.stringify({
                    name: call.name,
                    ok: result.ok,
                    duration_ms: duration,
                  }),
                });
                invocationEvents.push({
                  name: call.name,
                  args: call.args,
                  ok: result.ok,
                  duration_ms: duration,
                });
                return result;
              },
            },
            traceSink: deps.traceSink,
          },
          {
            query,
            routerDecision: decision,
            retrievedChunks: [],
            traceId,
          },
          {
            maxIterations: MAX_ITERATIONS,
            timeBudgetMs: TIME_BUDGET_MS,
            signal: c.req.raw.signal,
          },
        );

        // Synthesizer stream — yield deltas as they arrive.
        const answerParts: string[] = [];
        for await (const delta of deps.synthesizer.synthesizeStream({
          query,
          routerDecision: decision,
          toolResults: loopResult.toolInvocations,
          history,
        })) {
          if (delta.text.length > 0) {
            await stream.writeSSE({
              event: 'answer-delta',
              data: JSON.stringify({ text: delta.text }),
            });
            answerParts.push(delta.text);
          }
        }
        finalAssistantText = answerParts.join('');

        // Final metadata event. Same fields as the JSON route's
        // response body — clients built for one work for the other.
        const substituteHandles = extractSubstituteHandles(loopResult.toolInvocations);
        const deliveryZoneStatus = extractDeliveryZoneStatus(loopResult.toolInvocations);
        const productLinks = extractProductLinks(loopResult.toolInvocations);
        const citations = extractCitations(loopResult.toolInvocations);
        const retrievedChunkIds = extractRetrievedChunkIds(loopResult.toolInvocations);
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            trace_id: traceId,
            intent: decision.intent,
            adversarial_suspected: decision.adversarialSuspected,
            adversarial_pattern: decision.adversarialPattern ?? null,
            product_query: decision.productQuery ?? null,
            behavior: 'answer',
            escalation_target: null,
            refusal_reason: null,
            tool_calls: invocationEvents,
            substitute_handles: substituteHandles,
            delivery_zone_status: deliveryZoneStatus,
            product_links: productLinks,
            citations,
            retrieved_chunk_ids: retrievedChunkIds,
            conversation_id: conversationId,
            rewritten_query: rewritten,
            degraded_reason: null,
          }),
        });
      } catch (error) {
        // GW-23 graceful escalate — same shape as the JSON route.
        // Emit a done event with escalate behaviour + degraded_reason
        // and close cleanly. The client renders staff-order copy.
        const message = error instanceof Error ? error.message : String(error);
        const escalate: Behaviour = {
          kind: 'escalate',
          escalationTarget: 'staff-order',
        };
        const copy = renderBehaviour(escalate) ?? '';
        if (copy) {
          await stream.writeSSE({
            event: 'answer-delta',
            data: JSON.stringify({ text: copy }),
          });
        }
        finalAssistantText = copy;
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            trace_id: null,
            intent: null,
            adversarial_suspected: false,
            adversarial_pattern: null,
            product_query: null,
            behavior: 'escalate',
            escalation_target: 'staff-order',
            refusal_reason: null,
            tool_calls: [],
            substitute_handles: [],
            delivery_zone_status: null,
            product_links: [],
            citations: [],
            retrieved_chunk_ids: [],
            conversation_id: conversationId,
            rewritten_query: null,
            degraded_reason: message,
          }),
        });
      } finally {
        // GW-16: persist both turns regardless of which path we took
        // (answer, safety refusal, or graceful escalate). Best-effort;
        // a store failure logs and continues rather than breaking a
        // successful stream. Turn IDs are generated locally.
        if (deps.conversationStore && conversationId && finalAssistantText) {
          try {
            const now = new Date().toISOString();
            await deps.conversationStore.appendTurn(conversationId, {
              turnId: newTurnId(),
              role: 'user',
              text: originalUserText,
              createdAt: now,
            });
            await deps.conversationStore.appendTurn(conversationId, {
              turnId: newTurnId(),
              role: 'assistant',
              text: finalAssistantText,
              createdAt: now,
            });
          } catch (err) {
            console.warn('conversation-append (stream): persistence failed', err);
          }
        }
      }
    });
  });

  return route;
}

function newTurnId(): string {
  return Math.random().toString(36).slice(2, 14);
}

function escalationTargetOf(b: Behaviour): string | null {
  return b.kind === 'escalate' ? b.escalationTarget : null;
}
