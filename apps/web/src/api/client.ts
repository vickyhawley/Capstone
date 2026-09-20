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

export async function postAnswer(query: string): Promise<AnswerResponse> {
  const res = await fetch('/api/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
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
