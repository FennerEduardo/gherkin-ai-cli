/* ==========================================================================
   gherkin-ai-cli - LLM provider contracts
   ========================================================================== */

import type { LLMProviderName } from '../config/schema';

export type { LLMProviderName };

export interface LLMRequest {
  system: string;
  user: string;
  /** JSON schema the response must satisfy (used for native structured output where supported). */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: LLMUsage;
}

export interface LLMProvider {
  readonly name: LLMProviderName;
  complete(request: LLMRequest, options?: { signal?: AbortSignal }): Promise<LLMResponse>;
}

export interface ResolvedLLMConfig {
  provider: LLMProviderName;
  model: string;
  apiKey?: string;
  /** Where the credential came from, for `ghk auth status` (never the secret itself). */
  credentialSource: string;
  baseUrl?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  azure?: { endpoint?: string; deployment?: string; apiVersion?: string; useEntraId?: boolean };
  bedrock?: { region?: string };
  vertex?: { project?: string; location?: string };
  budget?: { maxTokensPerRun?: number };
  /** Redact PII (in addition to secrets) from prompts before sending. */
  redactPii: boolean;
}
