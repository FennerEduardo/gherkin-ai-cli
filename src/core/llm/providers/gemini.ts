/* ==========================================================================
   gherkin-ai-cli - Google Gemini (API key) and Vertex AI (ADC)
   ========================================================================== */

import { GoogleGenAI } from '@google/genai';
import { ConfigError, ProviderError } from '../../errors';
import type { LLMProvider, LLMRequest, LLMResponse, ResolvedLLMConfig } from '../types';

export class GeminiProvider implements LLMProvider {
  readonly name: 'gemini' | 'vertex';
  private readonly client: GoogleGenAI;

  constructor(private readonly config: ResolvedLLMConfig) {
    this.name = config.provider === 'vertex' ? 'vertex' : 'gemini';
    const httpOptions = { timeout: config.timeoutMs, headers: config.headers, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) };
    if (this.name === 'vertex') {
      if (!config.vertex?.project) throw new ConfigError('Vertex AI requires llm.vertex.project (or GOOGLE_CLOUD_PROJECT).');
      // Authenticates with Application Default Credentials (gcloud auth application-default login, workload identity, ...).
      this.client = new GoogleGenAI({ vertexai: true, project: config.vertex.project, location: config.vertex.location || 'global', httpOptions });
    } else {
      if (!config.apiKey) throw new ConfigError('Gemini requires GEMINI_API_KEY (or a key stored with `ghk login --provider gemini`).');
      this.client = new GoogleGenAI({ apiKey: config.apiKey, httpOptions });
    }
  }

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    const label = this.name === 'vertex' ? 'Vertex AI' : 'Gemini';
    const attempts = this.config.maxRetries + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: this.config.model,
          contents: request.user,
          config: {
            systemInstruction: request.system,
            responseMimeType: 'application/json',
            maxOutputTokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
            abortSignal: options.signal
          }
        });
        return {
          text: response.text ?? '',
          model: response.modelVersion || this.config.model,
          usage: {
            inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0
          }
        };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (retryable && attempt < attempts && !options.signal?.aborted) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 30_000)));
          continue;
        }
        throw new ProviderError(`${label} error${status ? ` ${status}` : ''}: ${(err as Error).message}`, {
          status,
          retryable,
          cause: err,
          hint: status === 401 || status === 403 ? 'Check GEMINI_API_KEY or the ADC identity\'s Vertex AI permissions.' : undefined
        });
      }
    }
  }
}
