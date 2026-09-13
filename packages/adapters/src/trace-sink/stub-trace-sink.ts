import { NotImplementedError, type Span, type TraceSink } from '@groundwork/core';

export class StubTraceSink implements TraceSink {
  async record(_span: Span): Promise<void> {
    throw new NotImplementedError('TraceSink', 'Sprint 1', 'write spans to Supabase traces table');
  }
}
