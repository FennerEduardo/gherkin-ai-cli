/* ==========================================================================
   gherkin-ai-cli - Login & Auth Credentials Command
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';

export interface AuthConfig {
  token?: string;
  user?: string;
  provider?: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure-openai' | 'custom' | string;
  // API keys are explicitly removed from file storage for security.
  // Must be provided via environment variables (e.g. OPENAI_API_KEY).
  endpoint?: string;
  serverUrl?: string;
  loggedInAt?: string;
}

export function getAuthConfig(): AuthConfig | null {
  const authPath = path.join(os.homedir(), '.gherkin-ai', 'auth.json');
  if (!fs.existsSync(authPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const auth = JSON.parse(raw) as AuthConfig;
    // apiKey is no longer supported in file configuration
    return auth;
  } catch {
    return null;
  }
}

export function saveAuthConfig(auth: AuthConfig): string {
  const gheDir = path.join(os.homedir(), '.gherkin-ai');
  if (!fs.existsSync(gheDir)) {
    fs.mkdirSync(gheDir, { recursive: true });
  }

  const authPath = path.join(gheDir, 'auth.json');
  const payload: AuthConfig = {
    ...auth,
    loggedInAt: new Date().toISOString()
  };

  fs.writeFileSync(authPath, JSON.stringify(payload, null, 2), 'utf8');
  return authPath;
}

export async function handleLoginCommand(options?: {
  token?: string;
  user?: string;
  apiKey?: string;
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
  if (options?.apiKey) {
    logger.warn('⚠️ WARNING: For security, API keys are no longer stored in configuration files.');
    logger.warn('Please export your key as an environment variable (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY).');
  }
  const endpoint = options?.endpoint || process.env.GHK_AI_ENDPOINT || 'https://api.openai.com/v1';
  const serverUrl = options?.server || process.env.GHK_SERVER_URL || 'https://api.gherkin-ai.local';

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

  return authData;
}
