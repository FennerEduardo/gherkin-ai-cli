/* ==========================================================================
   gherkin-ai-cli - `ghk login` / `ghk logout` / `ghk auth status`

   SECURITY: API keys are NEVER written to disk by the CLI.
   - CI / servers: provider environment variables (OPENAI_API_KEY, ...).
   - Workstations: `ghk login` stores the key in the OS keychain
     (macOS Keychain, Windows Credential Manager, Linux Secret Service).
   The chosen provider (not the key) is saved in ~/.gherkin-ai/config.json.
   ========================================================================== */

import { emitJson } from '../utils/output';
import fs from 'fs';
import os from 'os';
import path from 'path';
import inquirer from 'inquirer';
import { loadConfig, updateUserConfig } from '../core/config';
import { LLM_PROVIDERS, LLMProviderName } from '../core/config/schema';
import { ConfigError, GhkError, UsageError } from '../core/errors';
import { resolveLLMSettings } from '../core/llm';
import {
  AMBIENT_CREDENTIAL_PROVIDERS,
  PROVIDER_KEY_ENV,
  deleteKeyFromKeychain,
  isKeychainAvailable,
  storeKeyInKeychain
} from '../core/llm/credentials';
import { getRunContext, isNonInteractive } from '../core/run-context';
import { logger } from '../utils/logger';

export interface LoginOptions {
  provider?: string;
  apiKeyStdin?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
}

const AMBIENT_HINTS: Partial<Record<LLMProviderName, string>> = {
  bedrock: 'Uses the standard AWS credential chain (AWS_PROFILE, SSO, environment, instance/IRSA role). Set AWS_REGION or llm.bedrock.region.',
  vertex: 'Uses Google Application Default Credentials (`gcloud auth application-default login` or workload identity). Set GOOGLE_CLOUD_PROJECT or llm.vertex.project.',
  ollama: 'No credentials needed. Set LLM_BASE_URL or llm.baseUrl if Ollama is not on localhost:11434.',
  ide_delegate: 'No model is called; prompts are handed to your IDE agent.'
};

function parseProvider(value: string | undefined): LLMProviderName | undefined {
  if (!value) return undefined;
  const normalized = value === 'azure' ? 'azure-openai' : value;
  if (!(LLM_PROVIDERS as readonly string[]).includes(normalized)) {
    throw new UsageError(`Unknown provider "${value}".`, { hint: `Use one of: ${LLM_PROVIDERS.join(', ')}.` });
  }
  return normalized as LLMProviderName;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('--api-key-stdin expects the key on standard input (e.g. `printenv KEY | ghk login --api-key-stdin`).');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function handleLoginCommand(options: LoginOptions = {}): Promise<{ provider: LLMProviderName; stored: 'keychain' | 'none'; configPath: string }> {
  logger.banner();
  const nonInteractive = isNonInteractive(options);

  let provider = parseProvider(options.provider);
  if (!provider) {
    if (nonInteractive) throw new UsageError('--provider is required in non-interactive mode.');
    const answer = await inquirer.prompt([{ type: 'list', name: 'provider', message: 'LLM provider:', choices: LLM_PROVIDERS.filter(p => p !== 'ide_delegate') }]);
    provider = answer.provider as LLMProviderName;
  }

  let stored: 'keychain' | 'none' = 'none';
  if (!AMBIENT_CREDENTIAL_PROVIDERS.has(provider)) {
    let apiKey: string | undefined;
    if (options.apiKeyStdin) {
      apiKey = await readStdin();
    } else if (!nonInteractive) {
      const answer = await inquirer.prompt([{ type: 'password', name: 'apiKey', mask: '*', message: `API key for ${provider} (leave empty to use ${PROVIDER_KEY_ENV[provider][0]}):` }]);
      apiKey = String(answer.apiKey || '').trim() || undefined;
    }

    if (apiKey) {
      if (!isKeychainAvailable() || !storeKeyInKeychain(provider, apiKey)) {
        throw new ConfigError('The OS keychain is not available, so the key cannot be stored securely.', {
          hint: `Set ${PROVIDER_KEY_ENV[provider][0]} in the environment instead (recommended for CI and servers).`
        });
      }
      stored = 'keychain';
    }
  }

  const configPath = updateUserConfig({ llm: { provider } });

  logger.success(`✔ Provider set to ${provider} in ${configPath}`);
  if (stored === 'keychain') {
    logger.info('   🔒 API key stored in the OS keychain (never on disk).');
  } else if (AMBIENT_HINTS[provider]) {
    logger.info(`   ${AMBIENT_HINTS[provider]}`);
  } else {
    logger.info(`   🔑 Set ${PROVIDER_KEY_ENV[provider].join(' or ')} in the environment, or re-run \`ghk login --provider ${provider}\` interactively.`);
  }
  warnLegacyAuthFile();

  return { provider, stored, configPath };
}

export async function handleLogoutCommand(options: { provider?: string; all?: boolean } = {}): Promise<{ removed: LLMProviderName[] }> {
  const providers: LLMProviderName[] = options.all || !options.provider
    ? LLM_PROVIDERS.filter(p => !AMBIENT_CREDENTIAL_PROVIDERS.has(p))
    : [parseProvider(options.provider) as LLMProviderName];
  const removed = providers.filter(p => deleteKeyFromKeychain(p));
  if (getRunContext().json) {
    emitJson({ ok: true, removed });
  } else if (removed.length) {
    logger.success(`✔ Removed keychain credentials for: ${removed.join(', ')}`);
  } else {
    logger.info('No keychain credentials found.');
  }
  return { removed };
}

export async function handleAuthStatusCommand(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const status: Record<string, unknown> = {
    keychainAvailable: isKeychainAvailable(),
    proxy: config.network?.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || null,
    caFile: config.network?.caFile || process.env.NODE_EXTRA_CA_CERTS || null
  };
  try {
    const llm = resolveLLMSettings({ config });
    Object.assign(status, {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      credentialSource: llm.credentialSource,
      endpoint: llm.provider === 'azure-openai' ? llm.azure?.endpoint : llm.baseUrl ?? null,
      timeoutMs: llm.timeoutMs,
      maxRetries: llm.maxRetries
    });
  } catch (err) {
    if (!(err instanceof GhkError)) throw err;
    Object.assign(status, { ok: false, error: err.message, hint: err.hint });
  }

  if (getRunContext().json) {
    emitJson(status);
  } else {
    for (const [key, value] of Object.entries(status)) {
      if (key === 'ok') continue;
      logger.info(`${key.padEnd(18)} ${value ?? '-'}`);
    }
  }
  if (status.ok === false) process.exitCode = 3;
  return status;
}

function warnLegacyAuthFile(): void {
  const legacy = path.join(os.homedir(), '.gherkin-ai', 'auth.json');
  if (fs.existsSync(legacy)) {
    logger.warn(`⚠️  ${legacy} is no longer used (provider now lives in config.json). You can delete it.`);
  }
}
