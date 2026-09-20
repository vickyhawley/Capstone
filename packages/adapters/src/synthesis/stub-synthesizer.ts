/**
 * Test-only stub synthesizer. Returns a fixed answer, echoing the
 * intent + tool count in the rationale so tests can assert what
 * shape reached the port without invoking a real LLM. Same shape
 * pattern as StubRouter / StubRetriever.
 */
import type {
  Synthesizer,
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
}
