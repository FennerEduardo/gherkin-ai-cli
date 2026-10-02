/* ==========================================================================
   gherkin-ai-cli - Anthropic (Claude API) and Amazon Bedrock
   ========================================================================== */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { ProviderError } from '../../errors';
import type { LLMProvider, LLMRequest, LLMResponse, ResolvedLLMConfig } from '../types';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`) on the Claude API. */
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function toProviderError(err: unknown, label: string): never {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const hint = err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
      ? 'Check ANTHROPIC_API_KEY (or the AWS credentials/region for Bedrock).'
      : err instanceof Anthropic.NotFoundError ? 'Check llm.model (Bedrock model ids use the "anthropic." prefix).' : undefined;
    throw new ProviderError(`${label} error${status ? ` ${status}` : ''}: ${err.message}`, {
      status: typeof status === 'number' ? status : undefined,
      retryable: err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError,
      hint,
      cause: err
    });
  }
  throw new ProviderError(`${label} request failed: ${(err as Error).message}`, { cause: err });
}

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number };
}

function toResponse(message: MessageLike, label: string): LLMResponse {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unspecified';
    throw new ProviderError(`${label} declined the request (refusal, category: ${category}).`, {
      hint: message.stop_details?.explanation ?? undefined
    });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ProviderError(`${label} response was truncated at max_tokens.`, { hint: 'Increase llm.maxOutputTokens.' });
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  return { text, model: message.model, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
}

function outputConfig(request: LLMRequest) {
  return request.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: request.jsonSchema } } } : {};
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly config: ResolvedLLMConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
      defaultHeaders: config.headers
    });
  }

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    const base = {
      model: this.config.model,
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user' as const, content: request.user }],
      ...outputConfig(request)
    };
    try {
      // On the first-party API, opt into server-side refusal fallbacks for models that support them.
      if (!this.config.baseUrl && SERVER_FALLBACK_MODELS.has(this.config.model)) {
        const message = await this.client.beta.messages.create(
          { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal: options.signal }
        );
        return toResponse(message as unknown as MessageLike, 'Anthropic');
      }
      const message = await this.client.messages.create(base, { signal: options.signal });
      return toResponse(message as unknown as MessageLike, 'Anthropic');
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      toProviderError(err, 'Anthropic');
    }
  }
}

export class BedrockProvider implements LLMProvider {
  readonly name = 'bedrock' as const;
  private readonly client: AnthropicBedrockMantle;

  constructor(private readonly config: ResolvedLLMConfig) {
    // Credentials come from the standard AWS chain (env, profile, SSO, instance/IRSA role).
    this.client = new AnthropicBedrockMantle({
      awsRegion: config.bedrock?.region,
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
      defaultHeaders: config.headers
    });
  }

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    try {
      const message = await this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          ...outputConfig(request)
        },
        { signal: options.signal }
      );
      return toResponse(message as unknown as MessageLike, 'Bedrock');
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      toProviderError(err, 'Bedrock');
    }
  }
}
