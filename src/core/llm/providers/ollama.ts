/* ==========================================================================
   gherkin-ai-cli - Ollama (local / air-gapped)
   ========================================================================== */

import { DEFAULT_OLLAMA_URL } from '../defaults';
import { fetchWithRetry } from '../retry';
import type { LLMProvider, LLMRequest, LLMResponse, ResolvedLLMConfig } from '../types';

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;

  constructor(private readonly config: ResolvedLLMConfig) {}

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    const res = await fetchWithRetry(
      this.config.baseUrl || DEFAULT_OLLAMA_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body: JSON.stringify({ model: this.config.model, system: request.system, prompt: request.user, stream: false, format: 'json' })
      },
      { maxRetries: this.config.maxRetries, timeoutMs: this.config.timeoutMs, signal: options.signal, label: 'Ollama' }
    );
    const data = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number; model?: string };
    return {
      text: data.response ?? '',
      model: data.model || this.config.model,
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 }
    };
  }
}
