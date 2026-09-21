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

  it('renders logistics.shop_info with phone, hours, address, how-to-order', () => {
    const text = renderToolFindings([
      makeToolRecord(
        'logistics.shop_info',
        true,
        {
          topic: 'contact',
          info: {
            phone: '01425 201301',
            messaging: 'WhatsApp on the same number',
            email: null,
            address: { locality: 'Ringwood', postcode: 'BH24', street: null },
            openingHours: {
              monday: '8:30am – 6:00pm',
              tuesday: '8:30am – 6:00pm',
              wednesday: '8:30am – 6:00pm',
              thursday: '8:30am – 6:00pm',
              friday: '8:30am – 6:00pm',
              saturday: '8:30am – 4:00pm',
              sunday: '8:30am – 2:00pm',
            },
            bankHolidays: 'Open on bank holidays; Christmas/Boxing Day exceptions.',
            howToOrder: ['Phone', 'WhatsApp'],
            deliverySummary: 'Free within 20 miles',
          },
        },
        { topic: 'contact' },
      ),
    ]);
    expect(text).toContain('phone=01425 201301');
    expect(text).toContain('Ringwood');
    expect(text).toContain('mon 8:30am');
    expect(text).toContain('sun 8:30am');
    expect(text).toContain('WhatsApp');
    expect(text).toContain('topic=contact');
  });

  it('flags subscriptionEligible=true in stock_lookup findings; drops false/null', () => {
    const withFlag = renderToolFindings([
      makeToolRecord(
        'product.stock_lookup',
        true,
        {
          status: 'exact',
          matchedTitle: 'Coarse Mix',
          subscriptionEligible: true,
        },
      ),
    ]);
    expect(withFlag).toContain('subscriptionEligible=true');

    const withoutFlag = renderToolFindings([
      makeToolRecord(
        'product.stock_lookup',
        true,
        {
          status: 'exact',
          matchedTitle: 'Wax Jacket',
          subscriptionEligible: false,
        },
      ),
    ]);
    expect(withoutFlag).not.toContain('subscriptionEligible');
  });

  it('includes subscriptionDelivery in shop_info findings when present', () => {
    const text = renderToolFindings([
      makeToolRecord(
        'logistics.shop_info',
        true,
        {
          topic: 'ordering',
          info: {
            phone: '01425 201301',
            howToOrder: ['Phone', 'WhatsApp'],
            subscriptionDelivery: {
              description: 'Regular delivery for feed / bedding / haylage',
              eligibleTypes: ['Feed', 'Bedding', 'Haylage'],
            },
          },
        },
      ),
    ]);
    expect(text).toContain('subscriptionDelivery');
    expect(text).toContain('Feed');
    expect(text).toContain('Regular delivery');
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

  // ---------- synthesizeStream ----------

  /** Mock a Stream<ChatCompletionChunk> from an array of delta
   *  strings. Real SDK returns an async iterable; we mirror that. */
  function makeStream(deltas: readonly string[]): AsyncIterable<{
    readonly choices: readonly { readonly delta: { readonly content: string } }[];
  }> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const text of deltas) {
          yield { choices: [{ delta: { content: text } }] };
        }
      },
    };
  }

  it('yields deltas as the model streams', async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(makeStream(['Yes,', ' we', ' have it.'])),
        },
      },
    } as unknown as OpenAI;
    const synth = new OpenAiSynthesizer(openai);
    const deltas: string[] = [];
    for await (const d of synth.synthesizeStream({
      query: { text: 'do you have it' },
      routerDecision: makeDecision(),
      toolResults: [],
    })) {
      deltas.push(d.text);
    }
    // Content deltas + one empty done-marker at the end.
    expect(deltas).toEqual(['Yes,', ' we', ' have it.', '']);
  });

  it('marks only the final delta as done', async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(makeStream(['a', 'b'])),
        },
      },
    } as unknown as OpenAI;
    const synth = new OpenAiSynthesizer(openai);
    const flags: boolean[] = [];
    for await (const d of synth.synthesizeStream({
      query: { text: 'x' },
      routerDecision: makeDecision(),
      toolResults: [],
    })) {
      flags.push(d.done);
    }
    // Every content delta is done:false; final marker is done:true.
    expect(flags).toEqual([false, false, true]);
  });

  it('empty stream falls back to canned answer as a single done-delta', async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(makeStream([])),
        },
      },
    } as unknown as OpenAI;
    const synth = new OpenAiSynthesizer(openai);
    const out: { text: string; done: boolean }[] = [];
    for await (const d of synth.synthesizeStream({
      query: { text: 'x' },
      routerDecision: makeDecision(),
      toolResults: [],
    })) {
      out.push(d);
    }
    expect(out).toHaveLength(1);
    expect(out[0]?.done).toBe(true);
    expect(out[0]?.text).toContain('give the shop a call');
  });

  it('propagates infra failure from the stream call', async () => {
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('stream 503')),
        },
      },
    } as unknown as OpenAI;
    const synth = new OpenAiSynthesizer(openai);
    const iterate = async (): Promise<void> => {
      for await (const _d of synth.synthesizeStream({
        query: { text: 'x' },
        routerDecision: makeDecision(),
        toolResults: [],
      })) {
        // consume
      }
    };
    await expect(iterate()).rejects.toThrow('stream 503');
  });
});
