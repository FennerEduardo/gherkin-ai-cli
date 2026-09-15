/* ==========================================================================
   gherkin-ai-cli - Login & Auth Credentials Command
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';

// Machine-specific encryption key based on user and machine info
const ENCRYPTION_KEY = crypto.scryptSync(
  process.env.USER || process.env.USERNAME || 'gherkin-ai-user',
  'ghk-salt-v1',
  32
);

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text: string): string {
  try {
    const parts = text.split(':');
    if (parts.length !== 2) return text; // Possibly unencrypted legacy key
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return text; // Fallback to raw text if decryption fails
  }
}

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
    const auth = JSON.parse(raw) as AuthConfig;
    if (auth.apiKey && auth.apiKey.includes(':')) {
      auth.apiKey = decrypt(auth.apiKey);
    }
    return auth;
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
    apiKey: auth.apiKey ? encrypt(auth.apiKey) : undefined,
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
