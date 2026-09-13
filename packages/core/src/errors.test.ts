import { describe, expect, it } from 'vitest';
import { NotImplementedError } from './errors.js';

describe('NotImplementedError', () => {
  it('names the port and planned sprint', () => {
    const err = new NotImplementedError('Retriever', 'Sprint 1');
    expect(err.port).toBe('Retriever');
    expect(err.plannedFor).toBe('Sprint 1');
    expect(err.message).toContain('Retriever');
    expect(err.message).toContain('Sprint 1');
  });

  it('appends a detail suffix when provided', () => {
    const err = new NotImplementedError('LanguageModel', 'Sprint 1', 'no LLM_API_KEY set');
    expect(err.message).toContain('no LLM_API_KEY set');
  });
});
