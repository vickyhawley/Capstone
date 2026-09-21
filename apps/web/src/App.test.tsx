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
    },
  ],
};

describe('App — chat shell smoke', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/answer') {
        return new Response(JSON.stringify(CANNED_ANSWER), {
          status: 200,
          headers: { 'content-type': 'application/json' },
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
    expect(screen.getByText('Groundwork')).toBeTruthy();
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

    // Fetch was called with the query.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/answer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'do you sell HorseHage Timothy' }),
      }),
    );
  });

  it('renders product-link chips below the bot answer', async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('Ask something…'), {
      target: { value: 'do you sell HorseHage Timothy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => screen.getByText(CANNED_ANSWER.answer));

    // Chip renders as a link with target=_blank and the storefront URL.
    const chip = screen.getByRole('link', { name: /HorseHage Timothy/ });
    expect(chip.getAttribute('href')).toBe(
      'https://newforestcountrystore.co.uk/products/horsehage-timothy',
    );
    expect(chip.getAttribute('target')).toBe('_blank');
    expect(chip.getAttribute('rel')).toBe('noopener noreferrer');
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
