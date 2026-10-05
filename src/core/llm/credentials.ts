/* ==========================================================================
   gherkin-ai-cli - Provider credential resolution

   Precedence: provider-specific environment variable → OS keychain.
   Secrets are never written to disk by the CLI.

   Bedrock (AWS credential chain), Vertex (Google ADC) and Ollama need no API
   key: their SDKs resolve ambient credentials themselves.
   ========================================================================== */

import type { LLMProviderName } from './types';

export const KEYCHAIN_SERVICE = 'gherkin-ai-cli';

/** Environment variables checked, in order, for each provider. Never falls back to another provider's key. */
export const PROVIDER_KEY_ENV: Record<LLMProviderName, string[]> = {
  openai: ['OPENAI_API_KEY'],
  'openai-compatible': ['LLM_API_KEY', 'OPENAI_API_KEY'],
  'azure-openai': ['AZURE_OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  bedrock: [],
  vertex: [],
  ollama: [],
  ide_delegate: []
};

/** Providers whose credentials come from the cloud SDK's ambient chain instead of an API key. */
export const AMBIENT_CREDENTIAL_PROVIDERS: ReadonlySet<LLMProviderName> = new Set(['bedrock', 'vertex', 'ollama', 'ide_delegate']);

export interface CredentialResolution {
  apiKey?: string;
  /** e.g. "env:ANTHROPIC_API_KEY", "keychain", "ambient", "none" */
  source: string;
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean | void;
}

type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

let keyringOverride: KeyringModule | null | undefined;

/** Test hook: inject a fake keychain (or null to simulate "unavailable"). */
export function __setKeyringForTests(mod: KeyringModule | null | undefined): void {
  keyringOverride = mod;
}

function loadKeyring(): KeyringModule | null {
  if (keyringOverride !== undefined) return keyringOverride;
  try {
    // Optional dependency: absent in minimal installs and most CI images.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@napi-rs/keyring') as KeyringModule;
  } catch {
    return null;
  }
}

export function isKeychainAvailable(): boolean {
  return loadKeyring() !== null;
}

export function getKeyFromKeychain(provider: LLMProviderName): string | undefined {
  const keyring = loadKeyring();
  if (!keyring) return undefined;
  try {
    return new keyring.Entry(KEYCHAIN_SERVICE, provider).getPassword() || undefined;
  } catch {
    // No secret service (headless Linux), locked keychain, or no entry.
    return undefined;
  }
}

export function storeKeyInKeychain(provider: LLMProviderName, apiKey: string): boolean {
  const keyring = loadKeyring();
  if (!keyring) return false;
  try {
    new keyring.Entry(KEYCHAIN_SERVICE, provider).setPassword(apiKey);
    return true;
  } catch {
    return false;
  }
}

export function deleteKeyFromKeychain(provider: LLMProviderName): boolean {
  const keyring = loadKeyring();
  if (!keyring) return false;
  try {
    new keyring.Entry(KEYCHAIN_SERVICE, provider).deletePassword();
    return true;
  } catch {
    return false;
  }
}

export function resolveCredential(provider: LLMProviderName, env: NodeJS.ProcessEnv = process.env): CredentialResolution {
  for (const name of PROVIDER_KEY_ENV[provider]) {
    const value = env[name]?.trim();
    if (value) return { apiKey: value, source: `env:${name}` };
  }
  if (AMBIENT_CREDENTIAL_PROVIDERS.has(provider)) return { source: 'ambient' };
  const fromKeychain = getKeyFromKeychain(provider);
  if (fromKeychain) return { apiKey: fromKeychain, source: 'keychain' };
  return { source: 'none' };
}

/** Best-effort provider inference when none is configured. Order prefers explicit enterprise endpoints. */
export function inferProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProviderName | undefined {
  if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT) return 'azure-openai';
  if (env.LLM_BASE_URL && (env.LLM_API_KEY || env.OPENAI_API_KEY)) return 'openai-compatible';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini';
  return undefined;
}
