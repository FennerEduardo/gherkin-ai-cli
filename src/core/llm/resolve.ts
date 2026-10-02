/* ==========================================================================
   gherkin-ai-cli - LLM configuration resolution + policy enforcement

   Sources: resolved config (`llm.*`, layered org → user → project → env),
   legacy ~/.gherkin-ai/auth.json provider, then inference from env keys,
   finally local Ollama.

   Policies enforced here (PolicyError, exit code 5):
   - llm.allowedProviders / allowedModels / allowedBaseUrls (organization)
   - constitution security.allowedLLMProviders / forbiddenLLMProviders
   ========================================================================== */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { GherkinAIConfig, loadConfig } from '../config';
import { LLM_PROVIDERS, LLMProviderName } from '../config/schema';
import { loadConstitution, isLLMProviderAllowed } from '../constitution';
import { ConfigError, PolicyError } from '../errors';
import { logger } from '../../utils/logger';
import { inferProviderFromEnv, resolveCredential } from './credentials';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_RETRIES, DEFAULT_MODELS, DEFAULT_TIMEOUT_MS } from './defaults';
import type { ResolvedLLMConfig } from './types';

function legacyAuthProvider(): LLMProviderName | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gherkin-ai', 'auth.json'), 'utf8'));
    const provider = raw?.provider === 'azure' ? 'azure-openai' : raw?.provider;
    return (LLM_PROVIDERS as readonly string[]).includes(provider) ? provider : undefined;
  } catch {
    return undefined;
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

export interface ResolveLLMOptions {
  config?: GherkinAIConfig;
  env?: NodeJS.ProcessEnv;
  /** Skip constitution lookup (used by tests). */
  cwd?: string;
}

export function resolveLLMSettings(options: ResolveLLMOptions = {}): ResolvedLLMConfig {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig();
  const llm = config.llm ?? {};

  let provider = llm.provider ?? legacyAuthProvider() ?? inferProviderFromEnv(env);
  if (!provider) {
    provider = 'ollama';
    logger.info('No LLM provider configured and no API keys found; using local Ollama (air-gapped mode). Set llm.provider in gherkin-ai.config.json to choose another.');
  }

  const model = llm.model ?? (provider === 'azure-openai' ? llm.azure?.deployment : undefined) ?? DEFAULT_MODELS[provider];

  // ---- Organization policy ----
  if (llm.allowedProviders?.length && !llm.allowedProviders.includes(provider)) {
    throw new PolicyError(`LLM provider "${provider}" is not allowed by policy.`, { hint: `Allowed providers: ${llm.allowedProviders.join(', ')}.` });
  }
  if (llm.allowedModels?.length && provider !== 'ide_delegate' && !llm.allowedModels.some(p => matchesPattern(model, p))) {
    throw new PolicyError(`LLM model "${model}" is not allowed by policy.`, { hint: `Allowed models: ${llm.allowedModels.join(', ')}.` });
  }
  const endpoint = provider === 'azure-openai' ? llm.azure?.endpoint : llm.baseUrl;
  if (llm.allowedBaseUrls?.length && endpoint && !llm.allowedBaseUrls.some(p => matchesPattern(endpoint, p))) {
    throw new PolicyError(`LLM endpoint "${endpoint}" is not allowed by policy.`, { hint: `Allowed endpoints: ${llm.allowedBaseUrls.join(', ')}.` });
  }
  const constitution = loadConstitution(options.cwd ?? process.cwd());
  if (!isLLMProviderAllowed(provider, constitution)) {
    throw new PolicyError(`LLM provider "${provider}" is forbidden by the project constitution (.gherkin-ai/constitution.yaml).`);
  }

  const credential = resolveCredential(provider, env);
  const needsKey = !['ollama', 'ide_delegate', 'bedrock', 'vertex'].includes(provider) && !(provider === 'azure-openai' && llm.azure?.useEntraId);
  if (needsKey && !credential.apiKey) {
    throw new ConfigError(`No API key found for provider "${provider}".`, {
      hint: `Set the provider's environment variable or run \`ghk login --provider ${provider}\` to store it in the OS keychain.`
    });
  }

  return {
    provider,
    model,
    apiKey: credential.apiKey,
    credentialSource: credential.source,
    baseUrl: llm.baseUrl,
    headers: llm.headers ?? {},
    timeoutMs: llm.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: llm.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxOutputTokens: llm.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    azure: llm.azure,
    bedrock: llm.bedrock,
    vertex: llm.vertex,
    budget: llm.budget,
    redactPii: config.policy?.redactPii ?? false
  };
}
