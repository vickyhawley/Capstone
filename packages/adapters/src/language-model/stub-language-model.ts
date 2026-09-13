import {
  type CompletionChunk,
  type CompletionRequest,
  type LanguageModel,
  NotImplementedError,
} from '@groundwork/core';

export class StubLanguageModel implements LanguageModel {
  complete(_request: CompletionRequest): AsyncIterable<CompletionChunk> {
    throw new NotImplementedError('LanguageModel', 'Sprint 1', 'choose provider via LLM_PROVIDER');
  }
}
