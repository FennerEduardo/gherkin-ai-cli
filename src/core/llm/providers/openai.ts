/* ==========================================================================
   gherkin-ai-cli - OpenAI, OpenAI-compatible gateways and Azure OpenAI
   ========================================================================== */

import OpenAI, { AzureOpenAI } from 'openai';
import { ConfigError, ProviderError } from '../../errors';
import { DEFAULT_AZURE_API_VERSION } from '../defaults';
import type { LLMProvider, LLMRequest, LLMResponse, ResolvedLLMConfig } from '../types';

function toProviderError(err: unknown, label: string): never {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const hint = status === 401 || status === 403
      ? 'Check the API key / Entra ID permissions for this provider.'
      : status === 404 ? 'Check the model or Azure deployment name.' : undefined;
    throw new ProviderError(`${label} error${status ? ` ${status}` : ''}: ${err.message}`, {
      status,
      retryable: status === 429 || (status !== undefined && status >= 500),
      hint,
      cause: err
    });
  }
  throw new ProviderError(`${label} request failed: ${(err as Error).message}`, { cause: err, hint: 'Check network access, HTTPS_PROXY/NO_PROXY and network.caFile.' });
}

function loadEntraTokenProvider(): () => Promise<string> {
  try {
    // Optional dependency, only needed for keyless Azure (Microsoft Entra ID) auth.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const identity = require('@azure/identity');
    return identity.getBearerTokenProvider(new identity.DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default');
  } catch {
    throw new ConfigError('llm.azure.useEntraId requires the optional package @azure/identity.', { hint: 'Run `npm install -g @azure/identity` next to gherkin-ai, or use AZURE_OPENAI_API_KEY.' });
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name: ResolvedLLMConfig['provider'];
  private readonly client: OpenAI;
  private readonly label: string;

  constructor(private readonly config: ResolvedLLMConfig) {
    this.name = config.provider;
    const common = {
      timeout: config.timeoutMs,
      maxRetries: config.maxRetries,
      defaultHeaders: config.headers,
      // Use Node's global fetch so the proxy/CA dispatcher from core/net applies.
      fetch: globalThis.fetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch']
    };

    if (config.provider === 'azure-openai') {
      const azure = config.azure ?? {};
      if (!azure.endpoint) throw new ConfigError('Azure OpenAI requires llm.azure.endpoint (or AZURE_OPENAI_ENDPOINT).');
      if (!azure.deployment) throw new ConfigError('Azure OpenAI requires llm.azure.deployment (or AZURE_OPENAI_DEPLOYMENT).');
      if (!azure.useEntraId && !config.apiKey) throw new ConfigError('Azure OpenAI requires AZURE_OPENAI_API_KEY or llm.azure.useEntraId: true.');
      this.client = new AzureOpenAI({
        ...common,
        endpoint: azure.endpoint,
        deployment: azure.deployment,
        apiVersion: azure.apiVersion || DEFAULT_AZURE_API_VERSION,
        ...(azure.useEntraId ? { azureADTokenProvider: loadEntraTokenProvider() } : { apiKey: config.apiKey })
      });
      this.label = 'Azure OpenAI';
    } else {
      if (config.provider === 'openai-compatible' && !config.baseUrl) {
        throw new ConfigError('Provider "openai-compatible" requires llm.baseUrl (or LLM_BASE_URL).');
      }
      this.client = new OpenAI({ ...common, apiKey: config.apiKey, baseURL: config.baseUrl });
      this.label = config.provider === 'openai' ? 'OpenAI' : `Gateway (${config.baseUrl})`;
    }
  }

  async complete(request: LLMRequest, options: { signal?: AbortSignal } = {}): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.provider === 'azure-openai' ? this.config.azure?.deployment ?? this.config.model : this.config.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ],
          max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
          response_format: { type: 'json_object' }
        },
        { signal: options.signal }
      );
      return {
        text: response.choices[0]?.message?.content ?? '',
        model: response.model || this.config.model,
        usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 }
      };
    } catch (err) {
      toProviderError(err, this.label);
    }
  }
}
