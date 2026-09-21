/**
 * Test-only stub synthesizer. Returns a fixed answer, echoing the
 * intent + tool count in the rationale so tests can assert what
 * shape reached the port without invoking a real LLM. Same shape
 * pattern as StubRouter / StubRetriever.
 *
 * `synthesizeStream` yields the fixed string as a single delta so
 * SSE-path tests can assert the stream contract without staging
 * a fake ReadableStream.
 */
import type {
  Synthesizer,
  SynthesizerDelta,
  SynthesizerInput,
  SynthesizerOutput,
} from '@groundwork/core';

export class StubSynthesizer implements Synthesizer {
  constructor(private readonly answer: string = 'stub answer') {}

  async synthesize(input: SynthesizerInput): Promise<SynthesizerOutput> {
    return {
      answer: this.answer,
      rationale: `stub: intent=${input.routerDecision.intent}, tools=${input.toolResults.length}`,
    };
  }

  async *synthesizeStream(_input: SynthesizerInput): AsyncIterable<SynthesizerDelta> {
    // Single-delta stream — enough to exercise the SSE plumbing
    // in tests. Real streaming behaviour is tested against
    // OpenAiSynthesizer with a mocked stream.
    yield { text: this.answer, done: true };
  }
}
