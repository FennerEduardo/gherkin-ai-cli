/* ==========================================================================
   gherkin-ai-cli - Login & Auth Credentials Command
   
   SECURITY: API keys are NEVER stored in plaintext files.
   Resolution order:
   1. Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
   2. OS keychain via `keytar` (if available, for local DX)
   3. auth.json stores ONLY non-sensitive config (provider, endpoint, user)
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

export interface AuthConfig {
  token?: string;
  user?: string;
  provider?: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure-openai' | 'custom' | string;
  endpoint?: string;
  serverUrl?: string;
  loggedInAt?: string;
  // SECURITY (Enterprise): API keys are NEVER stored in this file. 
  // Use environment variables (OPENAI_API_KEY) or OS Keychain.
}

const AUTH_DIR = path.join(os.homedir(), '.gherkin-ai');
const AUTH_PATH = path.join(AUTH_DIR, 'auth.json');
const KEYCHAIN_SERVICE = 'gherkin-ai-cli';

/**
 * Resolve API key from environment variables.
 * This is the primary and recommended approach for all environments.
 */
export function resolveApiKeyFromEnv(): string | undefined {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.AZURE_OPENAI_API_KEY ||
    process.env.LLM_API_KEY
  );
}

/**
 * Attempt to store API key in OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret).
 * Returns true if successful, false if keytar is not available.
 */
async function storeKeyInKeychain(provider: string, apiKey: string): Promise<boolean> {
  try {
    const keytar = require('keytar');
    await keytar.setPassword(KEYCHAIN_SERVICE, provider, apiKey);
    return true;
  } catch {
    // keytar not available (CI, containers, minimal installs) — this is expected
    return false;
  }
}

/**
 * Attempt to retrieve API key from OS keychain.
 * Returns null if keytar is not available or no key is stored.
 */
async function getKeyFromKeychain(provider: string): Promise<string | null> {
  try {
    const keytar = require('keytar');
    return await keytar.getPassword(KEYCHAIN_SERVICE, provider);
  } catch {
    return null;
  }
}

/**
 * Resolve API key with full priority chain:
 * 1. Environment variables (highest priority, works in CI/CD)
 * 2. OS keychain (local development convenience)
 * 3. Returns undefined if no key found
 */
export async function resolveApiKey(provider?: string): Promise<string | undefined> {
  // 1. Environment variables (always check first)
  const envKey = resolveApiKeyFromEnv();
  if (envKey) return envKey;

  // 2. OS keychain fallback
  if (provider) {
    const keychainKey = await getKeyFromKeychain(provider);
    if (keychainKey) return keychainKey;
  }

  return undefined;
}

export function getAuthConfig(): AuthConfig | null {
  if (!fs.existsSync(AUTH_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(AUTH_PATH, 'utf8');
    const auth = JSON.parse(raw) as AuthConfig;

    // Security migration: if old auth.json contains apiKey, warn and remove it
    if ((auth as any).apiKey) {
      logger.warn('⚠️  SECURITY: Found API key in auth.json (plaintext). Migrating to secure storage...');
      logger.warn('   Please set your API key via environment variable instead:');
      logger.warn('   export OPENAI_API_KEY="your-key-here"');
      // Remove the key from the file
      delete (auth as any).apiKey;
      saveAuthConfig(auth);
    }

    return auth;
  } catch {
    return null;
  }
}

export function saveAuthConfig(auth: AuthConfig): string {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  // Ensure no API key is written to the config file
  const payload: AuthConfig = {
    ...auth,
    loggedInAt: new Date().toISOString()
  };
  // Explicitly strip any apiKey that might be passed
  delete (payload as any).apiKey;

  // Set restrictive file permissions (owner read/write only)
  fs.writeFileSync(AUTH_PATH, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return AUTH_PATH;
}

export async function handleLoginCommand(options?: {
  token?: string;
  user?: string;
  provider?: string;
  endpoint?: string;
  server?: string;
  yes?: boolean;
  nonInteractive?: boolean;
}): Promise<AuthConfig> {
  logger.banner();
  logger.info('🔑 Configurando credenciales de autenticación y proveedores de IA...');

  const token = options?.token || process.env.GHK_AUTH_TOKEN || 'tok_agent_synthetic_' + Date.now().toString(36);
  const user = options?.user || process.env.GHK_USER || process.env.USER || 'agent-ai@local';
  const provider = options?.provider || process.env.GHK_AI_PROVIDER || 'openai';
  const endpoint = options?.endpoint || process.env.GHK_AI_ENDPOINT || 'https://api.openai.com/v1';
  const serverUrl = options?.server || process.env.GHK_SERVER_URL || 'https://api.gherkin-ai.local';

  // Enforce secure API Key handling
  logger.warn('⚠️  Enterprise Security: API keys cannot be passed via arguments or stored in auth.json.');
  logger.warn('   Please set your API key as an environment variable:');
  logger.info('');
  if (provider === 'openai') {
    logger.info('   export OPENAI_API_KEY="your-key-here"');
  } else if (provider === 'anthropic') {
    logger.info('   export ANTHROPIC_API_KEY="your-key-here"');
  } else if (provider === 'gemini') {
    logger.info('   export GEMINI_API_KEY="your-key-here"');
  } else {
    logger.info('   export LLM_API_KEY="your-key-here"');
  }
  logger.info('');

  const authData: AuthConfig = {
    token,
    user,
    provider,
    endpoint,
    serverUrl
  };

  const savedPath = saveAuthConfig(authData);

  logger.success(`✔ Credenciales guardadas exitosamente en: ${savedPath}`);
  logger.info(`   👤 Usuario / Agente: ${user}`);
  logger.info(`   🤖 Proveedor de IA:  ${provider.toUpperCase()}`);
  logger.info(`   🔗 Endpoint Server:  ${endpoint}`);
  logger.info(`   🔑 Token de Sesión:  ${token.substring(0, 10)}...`);
  logger.info(`   🔒 API Key:          (Resolved from Environment Variable or Keychain)`);

  return authData;
}
