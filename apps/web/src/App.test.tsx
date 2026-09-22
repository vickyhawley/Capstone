/**
 * Smoke test for the chat shell. Sprint 4 (UI).
 *
 * Proves the plumbing works end-to-end with a mocked fetch:
 * mount App → type a query → click Send → assert user message
 * appears → assert bot message renders the API's answer copy.
 *
 * Not exhaustive. Component-level behaviours (evidence toggle,
 * degraded indicator, error state) are shape checks handled by
 * TypeScript at build time; a full RTL matrix would double the
 * file size for a demo-scope UI. If bugs surface here, expand
 * this file.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type { AnswerResponse } from './api/types.js';

const CANNED_ANSWER: AnswerResponse = {
  answer: 'Yes, we stock HorseHage Timothy — in stock.',
  citations: [],
  retrieved_chunk_ids: [],
  refusal_reason: null,
  trace_id: 'trace-abc',
  intent: 'product',
  adversarial_suspected: false,
  adversarial_pattern: null,
  product_query: 'HorseHage Timothy',
  behavior: 'answer',
  escalation_target: null,
  tool_calls: [
    { name: 'product.stock_lookup', args: { productQuery: 'HorseHage Timothy' }, ok: true, duration_ms: 42 },
  ],
  substitute_handles: [],
  delivery_zone_status: null,
  product_links: [
    {
      handle: 'horsehage-timothy',
      title: 'HorseHage Timothy',
      url: 'https://newforestcountrystore.co.uk/products/horsehage-timothy',
      priceMin: 22.5,
      priceMax: 22.5,
    },
  ],
  conversation_id: 'test-conv-001',
  rewritten_query: null,
};

/**
 * Build an SSE-formatted ReadableStream body from a canned answer.
 * Emits one answer-delta with the full text, then a done event with
 * all the metadata. Mirrors the shape the real server produces.
 */
function sseStreamFromCanned(canned: AnswerResponse): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const {
    answer,
    citations: _citations,
    retrieved_chunk_ids: _chunks,
    ...metadata
  } = canned;
  void _citations;
  void _chunks;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frame('answer-delta', { text: answer })));
      controller.enqueue(encoder.encode(frame('done', metadata)));
      controller.close();
    },
  });
}

describe('App — chat shell smoke', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/answer/stream') {
        return new Response(sseStreamFromCanned(CANNED_ANSWER), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('not mocked', { status: 404 });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders header + input + empty state on mount', () => {
    render(<App />);
    // Header is a logo image, not text. Assert on the alt text.
    expect(screen.getByAltText('New Forest Country Store')).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask something…')).toBeTruthy();
    expect(screen.getByText(/What can I help you find/)).toBeTruthy();
  });

  it('submits a query and renders the bot response', async () => {
    render(<App />);
    const input = screen.getByPlaceholderText('Ask something…') as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: /send/i });

    fireEvent.change(input, { target: { value: 'do you sell HorseHage Timothy' } });
    fireEvent.click(sendButton);

    // User message appears immediately.
    expect(screen.getByText('do you sell HorseHage Timothy')).toBeTruthy();

    // Bot response appears after fetch resolves.
    await waitFor(() => {
      expect(screen.getByText(CANNED_ANSWER.answer)).toBeTruthy();
    });

    // Evidence panel is collapsed by default — the toggle label
    // includes the step count in customer-shaped copy.
    expect(screen.getByRole('button', { name: /what i checked/i })).toBeTruthy();

    // Fetch was called against the stream endpoint with the query.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/answer/stream',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'do you sell HorseHage Timothy' }),
      }),
    );
  });

  it('renders product cards below the bot answer', async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('Ask something…'), {
      target: { value: 'do you sell HorseHage Timothy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => screen.getByText(CANNED_ANSWER.answer));

    // Card renders as a link with target=_blank and the storefront URL.
    const card = screen.getByRole('link', { name: /HorseHage Timothy/ });
    expect(card.getAttribute('href')).toBe(
      'https://newforestcountrystore.co.uk/products/horsehage-timothy',
    );
    expect(card.getAttribute('target')).toBe('_blank');
    expect(card.getAttribute('rel')).toBe('noopener noreferrer');
    // Price and CTA render inside the card.
    expect(screen.getByText('£22.50')).toBeTruthy();
    expect(screen.getByText(/View/)).toBeTruthy();
  });

  it('expands the evidence panel when toggled', async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('Ask something…'), {
      target: { value: 'do you sell haynets' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => screen.getByText(CANNED_ANSWER.answer));

    // Open the panel; assert the customer-shaped tool label
    // renders (not the raw internal name).
    fireEvent.click(screen.getByRole('button', { name: /what i checked/i }));
    expect(screen.getByText(/Checked stock/)).toBeTruthy();
    // trace_id truncated to first 8 chars for the Reference row.
    expect(screen.getByText('trace-ab')).toBeTruthy();
  });
});
