/* ==========================================================================
   gherkin-ai-cli - LLM layer entry point

   LLMClient wraps a provider with the cross-cutting guarantees every call
   gets, regardless of provider:
   - secrets (and optionally PII) are redacted from prompts before sending,
   - the per-run token budget is enforced,
   - usage is reported to the telemetry/audit sink.
   ========================================================================== */

import { PolicyError } from '../errors';
import { redactSensitive } from '../security';
import type { LLMProvider, LLMRequest, LLMResponse, ResolvedLLMConfig } from './types';

export * from './types';
export { resolveLLMSettings } from './resolve';
export { DEFAULT_MODELS } from './defaults';

/** Instantiates the provider. SDKs are imported lazily so unused ones never load. */
export async function createLLMProvider(config: ResolvedLLMConfig): Promise<LLMProvider> {
  switch (config.provider) {
    case 'openai':
    case 'openai-compatible':
    case 'azure-openai': {
      const { OpenAIProvider } = await import('./providers/openai');
      return new OpenAIProvider(config);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./providers/anthropic');
      return new AnthropicProvider(config);
    }
    case 'bedrock': {
      const { BedrockProvider } = await import('./providers/anthropic');
      return new BedrockProvider(config);
    }
    case 'gemini':
    case 'vertex': {
      const { GeminiProvider } = await import('./providers/gemini');
      return new GeminiProvider(config);
    }
    case 'ollama': {
      const { OllamaProvider } = await import('./providers/ollama');
      return new OllamaProvider(config);
    }
    case 'ide_delegate':
      throw new Error('ide_delegate does not call a model; use DefaultCliAgentProvider.');
  }
}

export interface UsageEvent {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

type UsageListener = (event: UsageEvent) => void;
const usageListeners: UsageListener[] = [];
let tokensUsedThisRun = 0;

/** Subscribe to per-call usage (telemetry/audit sink). Returns an unsubscribe function. */
export function onLLMUsage(listener: UsageListener): () => void {
  usageListeners.push(listener);
  return () => {
    const i = usageListeners.indexOf(listener);
    if (i >= 0) usageListeners.splice(i, 1);
  };
}

export function getTokensUsedThisRun(): number {
  return tokensUsedThisRun;
}

export function resetRunBudget(): void {
  tokensUsedThisRun = 0;
}

function emit(event: UsageEvent): void {
  for (const listener of usageListeners) {
    try {
      listener(event);
    } catch {
      // A telemetry sink must never break an LLM call.
    }
  }
}

export class LLMClient {
  private providerPromise?: Promise<LLMProvider>;

  constructor(private readonly config: ResolvedLLMConfig, provider?: LLMProvider) {
    if (provider) this.providerPromise = Promise.resolve(provider);
  }

  get settings(): ResolvedLLMConfig {
    return this.config;
  }

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    const budget = this.config.budget?.maxTokensPerRun;
    if (budget && tokensUsedThisRun >= budget) {
      throw new PolicyError(`LLM token budget exhausted (${tokensUsedThisRun}/${budget} tokens this run).`, { hint: 'Raise llm.budget.maxTokensPerRun or split the work.' });
    }

    const safeRequest: LLMRequest = {
      ...request,
      system: redactSensitive(request.system, { pii: this.config.redactPii }),
      user: redactSensitive(request.user, { pii: this.config.redactPii })
    };

    const started = Date.now();
    try {
      this.providerPromise ??= createLLMProvider(this.config);
      const provider = await this.providerPromise;
      const response = await provider.complete(safeRequest, options);
      tokensUsedThisRun += response.usage.inputTokens + response.usage.outputTokens;
      emit({ provider: this.config.provider, model: response.model, ...response.usage, durationMs: Date.now() - started, ok: true });
      return response;
    } catch (err) {
      emit({ provider: this.config.provider, model: this.config.model, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - started, ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
