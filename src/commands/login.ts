/* ==========================================================================
   gherkin-ai-cli - Login & Auth Credentials Command
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface AuthConfig {
  token?: string;
  user?: string;
  provider?: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure-openai' | 'custom' | string;
  apiKey?: string;
  endpoint?: string;
  serverUrl?: string;
  loggedInAt?: string;
}

export function getAuthConfig(workspaceDir: string = process.cwd()): AuthConfig | null {
  const authPath = path.join(workspaceDir, '.gherkin-ai', 'auth.json');
  if (!fs.existsSync(authPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveAuthConfig(auth: AuthConfig, workspaceDir: string = process.cwd()): string {
  const gheDir = path.join(workspaceDir, '.gherkin-ai');
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
  const apiKey = options?.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || 'sk-synthetic-key';
  const endpoint = options?.endpoint || process.env.GHK_AI_ENDPOINT || 'https://api.openai.com/v1';
  const serverUrl = options?.server || process.env.GHK_SERVER_URL || 'https://api.gherkin-ai.local';

  const authData: AuthConfig = {
    token,
    user,
    provider,
    apiKey,
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
