/**
 * Unit tests for OpenAiSynthesizer. Sprint 4.
 *
 * Focused on the tool-findings-rendering shape and the failure-path
 * fallback — the LLM call itself is stubbed via a mock OpenAI client
 * so tests are fast and deterministic (same pattern as the router's
 * llm-classifier tests).
 */

import type { RouterDecision, ToolInvocationRecord } from '@groundwork/core';
import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import {
  OpenAiSynthesizer,
  renderToolFindings,
} from './openai-synthesizer.js';

function makeToolRecord(
  name: string,
  ok: boolean,
  valueOrError: unknown,
  args: Record<string, unknown> = {},
): ToolInvocationRecord {
  return {
    call: { name, args },
    result: ok
      ? { ok: true, value: valueOrError }
      : { ok: false, error: String(valueOrError), retryable: false },
    durationMs: 10,
  };
}

function makeDecision(): RouterDecision {
  return {
    intent: 'product',
    confidence: 1.0,
    rationale: 'test',
    matched: 'llm',
    adversarialSuspected: false,
  };
}

function makeMockOpenAI(responseContent: string | null = 'synthesized answer'): OpenAI {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: responseContent } }],
  });
  return {
    chat: { completions: { create } },
    // Cast — tests only exercise the chat.completions.create path.
  } as unknown as OpenAI;
}

describe('renderToolFindings', () => {
  it('returns an explicit "no tools ran" line for an empty list', () => {
    const text = renderToolFindings([]);
    expect(text).toContain('no tools ran');
  });

  it('renders product.stock_lookup with matchedTitle when present', () => {
    const text = renderToolFindings([
      makeToolRecord(
        'product.stock_lookup',
        true,
        { status: 'exact', matchedHandle: 'horsehage-timothy', matchedTitle: 'HorseHage Timothy' },
        { productQuery: 'purple horsehage' },
      ),
    ]);
    expect(text).toContain('status=exact');
    expect(text).toContain('matched="HorseHage Timothy"');
    expect(text).toContain('productQuery="purple horsehage"');
  });

  it('renders product.substitute_lookup with substitute titles', () => {
    const text = renderToolFindings([
      makeToolRecord('product.substitute_lookup', true, {
        substitutes: [
          { handle: 'hilight-conditioning-cubes', title: 'HiLight Conditioning Cubes' },
          { handle: 'baileys-1', title: 'Baileys No 1' },
        ],
      }),
    ]);
    expect(text).toContain('HiLight Conditioning Cubes');
    expect(text).toContain('Baileys No 1');
  });

  it('renders logistics.delivery_zone with district + reason', () => {
    const text = renderToolFindings([
      makeToolRecord(
        'logistics.delivery_zone',
        true,
        {
          status: 'within_radius',
          postcode: 'BH24',
          matchedDistrict: { postcode: 'BH24', locality: 'Ringwood', distanceMiles: 1 },
          reason: 'BH24 (Ringwood, ~1 miles) is within the stated 20-mile radius',
        },
        { postcode: 'BH24' },
      ),
    ]);
    expect(text).toContain('status=within_radius');
    expect(text).toContain('Ringwood');
    expect(text).toContain('20-mile radius');
  });

  it('flags failed tool results without hiding them', () => {
    const text = renderToolFindings([
      makeToolRecord('product.stock_lookup', false, 'supabase RPC error', { productQuery: 'X' }),
    ]);
    expect(text).toContain('FAILED');
    expect(text).toContain('supabase RPC error');
  });

  it('summarises unknown tool shapes without crashing', () => {
    const text = renderToolFindings([
      makeToolRecord('some.new_tool', true, { foo: 'bar' }, { input: 'x' }),
    ]);
    expect(text).toContain('some.new_tool');
    expect(text).toContain('bar');
  });
});

describe('OpenAiSynthesizer', () => {
  it('calls the LLM with the tool findings + query in the user message', async () => {
    const openai = makeMockOpenAI('The shop stocks HorseHage Timothy — we have it in stock.');
    const synth = new OpenAiSynthesizer(openai);
    const result = await synth.synthesize({
      query: { text: 'do you sell purple horsehage' },
      routerDecision: { ...makeDecision(), productQuery: 'purple horsehage' },
      toolResults: [
        makeToolRecord(
          'product.stock_lookup',
          true,
          { status: 'exact', matchedTitle: 'HorseHage Timothy' },
          { productQuery: 'purple horsehage' },
        ),
      ],
    });
    expect(result.answer).toContain('HorseHage Timothy');

    // Verify the prompt shape reached the model.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createMock = (openai.chat.completions.create as any).mock;
    const args = createMock.calls[0][0];
    expect(args.model).toBe('gpt-4o');
    const messages = args.messages;
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('purple horsehage');
    expect(messages[1].content).toContain('Tool findings');
    expect(messages[1].content).toContain('status=exact');
  });

  it('falls back to a canned answer when the LLM returns empty content', async () => {
    const openai = makeMockOpenAI(null);
    const synth = new OpenAiSynthesizer(openai);
    const result = await synth.synthesize({
      query: { text: 'do you sell haynets' },
      routerDecision: { ...makeDecision(), productQuery: 'haynets' },
      toolResults: [],
    });
    expect(result.answer).toContain('give the shop a call');
    expect(result.rationale).toContain('fallback');
  });

  it('propagates infra failure — /api/answer catches at boundary', async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('openai 503')),
        },
      },
    } as unknown as OpenAI;
    const synth = new OpenAiSynthesizer(openai);
    await expect(
      synth.synthesize({
        query: { text: 'anything' },
        routerDecision: makeDecision(),
        toolResults: [],
      }),
    ).rejects.toThrow('openai 503');
  });
});
