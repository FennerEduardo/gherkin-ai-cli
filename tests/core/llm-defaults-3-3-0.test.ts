/* G-07 (3.3.0): the default Gemini model is one new API keys can use. */
import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from '../../src/core/llm/defaults';

describe('LLM defaults (G-07)', () => {
  it('Gemini defaults to the Flash-Lite alias; Vertex AI keeps its model', () => {
    expect(DEFAULT_MODELS.gemini).toBe('gemini-flash-lite-latest');
    expect(DEFAULT_MODELS.vertex).toBe('gemini-2.5-pro');
  });
});
