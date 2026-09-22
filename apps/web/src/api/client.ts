/**
 * Thin fetch wrapper for the Groundwork API. Sprint 4 (UI).
 *
 * Two calls today:
 *   - `postAnswer(query)` — the main product surface.
 *   - `getAbout()` — Article 50 disclosure + capability profile.
 *
 * Uses relative URLs (`/api/answer`, `/api/about`). In dev, Vite's
 * `server.proxy` config (vite.config.ts) forwards `/api → :8787`;
 * in production, the platform rewrites route it to the API function.
 * The web bundle stays origin-relative — no CORS surface.
 *
 * Error handling: network failures throw. Non-200 responses throw
 * with the status code + body text. Callers catch at the UI boundary
 * and render an error state.
 */
import type { AboutResponse, AnswerResponse } from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function postAnswer(
  query: string,
  conversationId?: string | null,
): Promise<AnswerResponse> {
  const res = await fetch('/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(conversationId ? { conversation_id: conversationId } : {}) }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as AnswerResponse;
}

export async function getAbout(): Promise<AboutResponse> {
  const res = await fetch('/api/about');
  if (!res.ok) {
    throw new ApiError(res.status, await res.text());
  }
  return (await res.json()) as AboutResponse;
}

// ---------- Streaming ----------

/**
 * Callback shape for streamAnswer. Every event type is optional —
 * a caller that only cares about the final metadata can just wire
 * onDone. `answer-delta` fires once per model chunk; the caller
 * accumulates into the message text.
 */
export interface StreamAnswerCallbacks {
  readonly onToolStart?: (event: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }) => void;
  readonly onToolComplete?: (event: {
    readonly name: string;
    readonly ok: boolean;
    readonly duration_ms: number;
  }) => void;
  readonly onAnswerDelta?: (event: { readonly text: string }) => void;
  /** The final done event carries the same fields as AnswerResponse
   *  minus the streamed `answer` text (which the caller assembled
   *  from onAnswerDelta). Shape is Omit<AnswerResponse, ...>. */
  readonly onDone?: (metadata: Omit<AnswerResponse, 'answer' | 'citations' | 'retrieved_chunk_ids'>) => void;
}

/**
 * POST /api/answer/stream and consume the SSE response, dispatching
 * events to the caller's callbacks. Returns when the stream closes.
 *
 * Uses fetch + ReadableStream + a small SSE parser rather than the
 * browser's EventSource — EventSource is GET-only, and we want to
 * POST the query in a JSON body.
 */
export async function streamAnswer(
  query: string,
  callbacks: StreamAnswerCallbacks,
  options?: { readonly signal?: AbortSignal; readonly conversationId?: string | null },
): Promise<void> {
  const res = await fetch('/api/answer/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      query,
      ...(options?.conversationId ? { conversation_id: options.conversationId } : {}),
    }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await res.text().catch(() => ''));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // SSE is framed as `event: X\ndata: Y\n\n` — blank line
  // terminates one event. Parse incrementally as chunks arrive.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameBoundary: number;
    while ((frameBoundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, frameBoundary);
      buffer = buffer.slice(frameBoundary + 2);
      dispatchEvent(frame, callbacks);
    }
  }

  // Final partial buffer — SSE closes with \n\n before EOF, but be
  // defensive: parse any complete frame still sitting there.
  if (buffer.trim().length > 0) {
    dispatchEvent(buffer, callbacks);
  }
}

function dispatchEvent(frame: string, callbacks: StreamAnswerCallbacks): void {
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // Ignore `id:`, `retry:`, comment lines — we don't use them.
  }
  if (dataLines.length === 0) return;
  const rawData = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    // Malformed data line — drop the event. Better than crashing
    // the whole stream over one bad frame.
    return;
  }

  switch (eventName) {
    case 'tool-start':
      callbacks.onToolStart?.(parsed as Parameters<NonNullable<StreamAnswerCallbacks['onToolStart']>>[0]);
      break;
    case 'tool-complete':
      callbacks.onToolComplete?.(parsed as Parameters<NonNullable<StreamAnswerCallbacks['onToolComplete']>>[0]);
      break;
    case 'answer-delta':
      callbacks.onAnswerDelta?.(parsed as Parameters<NonNullable<StreamAnswerCallbacks['onAnswerDelta']>>[0]);
      break;
    case 'done':
      callbacks.onDone?.(parsed as Parameters<NonNullable<StreamAnswerCallbacks['onDone']>>[0]);
      break;
  }
}
