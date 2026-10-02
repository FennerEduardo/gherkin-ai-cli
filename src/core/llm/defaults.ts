/* ==========================================================================
   gherkin-ai-cli - LLM defaults (single table; override with llm.model / LLM_MODEL)
   ========================================================================== */

import type { LLMProviderName } from './types';

export const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  openai: 'gpt-4.1',
  'openai-compatible': 'gpt-4.1',
  // Azure routes by deployment name; the model id is informational.
  'azure-openai': 'gpt-4.1',
  anthropic: 'claude-opus-5-5',
  bedrock: 'anthropic.claude-opus-5-5',
  gemini: 'gemini-2.5-pro',
  vertex: 'gemini-2.5-pro',
  ollama: 'llama3',
  ide_delegate: 'ide-delegate'
};

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Transport retries on 408/409/429/5xx and connection errors (attempts = maxRetries + 1). */
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const DEFAULT_AZURE_API_VERSION = '2024-10-21';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434/api/generate';
