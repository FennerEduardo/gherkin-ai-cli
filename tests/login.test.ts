import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleLoginCommand, handleLogoutCommand } from '../src/commands/login';
import { __setKeyringForTests, resolveCredential, inferProviderFromEnv } from '../src/core/llm/credentials';
import { ConfigError, UsageError } from '../src/core/errors';

class FakeEntry {
  static store = new Map<string, string>();
  constructor(private service: string, private account: string) {}
  private get key() { return `${this.service}/${this.account}`; }
  getPassword() { return FakeEntry.store.get(this.key) ?? null; }
  setPassword(pw: string) { FakeEntry.store.set(this.key, pw); }
  deletePassword() {
    if (!FakeEntry.store.has(this.key)) throw new Error('No entry');
    FakeEntry.store.delete(this.key);
    return true;
  }
}

describe('Credential resolution', () => {
  afterEach(() => __setKeyringForTests(undefined));

  it('uses only the selected provider\'s variable, never another provider\'s key', () => {
    __setKeyringForTests(null);
    const env = { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant-xyz' };
    expect(resolveCredential('anthropic', env)).toEqual({ apiKey: 'sk-ant-xyz', source: 'env:ANTHROPIC_API_KEY' });
    expect(resolveCredential('openai', env)).toEqual({ apiKey: 'sk-openai', source: 'env:OPENAI_API_KEY' });
    expect(resolveCredential('gemini', env)).toEqual({ source: 'none' });
    expect(resolveCredential('azure-openai', env)).toEqual({ source: 'none' });
  });

  it('prefers environment over keychain and falls back to keychain', () => {
    FakeEntry.store.clear();
    __setKeyringForTests({ Entry: FakeEntry });
    FakeEntry.store.set('gherkin-ai-cli/anthropic', 'sk-ant-from-keychain');
    expect(resolveCredential('anthropic', {})).toEqual({ apiKey: 'sk-ant-from-keychain', source: 'keychain' });
    expect(resolveCredential('anthropic', { ANTHROPIC_API_KEY: 'sk-env' }).source).toBe('env:ANTHROPIC_API_KEY');
  });

  it('treats cloud providers as ambient credentials', () => {
    __setKeyringForTests(null);
    expect(resolveCredential('bedrock', {})).toEqual({ source: 'ambient' });
    expect(resolveCredential('vertex', {})).toEqual({ source: 'ambient' });
  });

  it('infers enterprise endpoints before public providers', () => {
    expect(inferProviderFromEnv({ AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_ENDPOINT: 'https://x', OPENAI_API_KEY: 'o' })).toBe('azure-openai');
    expect(inferProviderFromEnv({ LLM_BASE_URL: 'https://gw', LLM_API_KEY: 'k' })).toBe('openai-compatible');
    expect(inferProviderFromEnv({})).toBeUndefined();
  });
});

describe('ghk login / logout', () => {
  let dir: string;
  const prevUserConfig = process.env.GHK_USER_CONFIG;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-login-'));
    process.env.GHK_USER_CONFIG = path.join(dir, 'config.json');
    FakeEntry.store.clear();
  });

  afterEach(() => {
    __setKeyringForTests(undefined);
    if (prevUserConfig === undefined) delete process.env.GHK_USER_CONFIG;
    else process.env.GHK_USER_CONFIG = prevUserConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saves only the provider (never a key) to the user config in non-interactive mode', async () => {
    __setKeyringForTests({ Entry: FakeEntry });
    const result = await handleLoginCommand({ provider: 'anthropic', nonInteractive: true });
    expect(result).toMatchObject({ provider: 'anthropic', stored: 'none' });
    const saved = JSON.parse(fs.readFileSync(process.env.GHK_USER_CONFIG!, 'utf8'));
    expect(saved).toEqual({ llm: { provider: 'anthropic' } });
    expect(FakeEntry.store.size).toBe(0);
  });

  it('normalizes the legacy "azure" provider name and rejects unknown providers', async () => {
    await expect(handleLoginCommand({ provider: 'azure', nonInteractive: true })).resolves.toMatchObject({ provider: 'azure-openai' });
    await expect(handleLoginCommand({ provider: 'custom', nonInteractive: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('requires --provider in non-interactive mode', async () => {
    await expect(handleLoginCommand({ nonInteractive: true })).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses to fall back to disk when the keychain is unavailable', async () => {
    __setKeyringForTests(null);
    const stdin = process.stdin as unknown as { isTTY?: boolean; [Symbol.asyncIterator]: () => AsyncIterator<Buffer> };
    const original = { isTTY: stdin.isTTY, iter: stdin[Symbol.asyncIterator] };
    stdin.isTTY = false;
    stdin[Symbol.asyncIterator] = async function* () { yield Buffer.from('sk-secret\n'); } as never;
    try {
      await expect(handleLoginCommand({ provider: 'openai', apiKeyStdin: true, nonInteractive: true })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      stdin.isTTY = original.isTTY;
      stdin[Symbol.asyncIterator] = original.iter;
    }
    expect(fs.existsSync(process.env.GHK_USER_CONFIG!)).toBe(false);
  });

  it('stores a stdin key in the keychain and logout removes it', async () => {
    __setKeyringForTests({ Entry: FakeEntry });
    const stdin = process.stdin as unknown as { isTTY?: boolean; [Symbol.asyncIterator]: () => AsyncIterator<Buffer> };
    const original = { isTTY: stdin.isTTY, iter: stdin[Symbol.asyncIterator] };
    stdin.isTTY = false;
    stdin[Symbol.asyncIterator] = async function* () { yield Buffer.from('sk-secret-123\n'); } as never;
    try {
      const result = await handleLoginCommand({ provider: 'openai', apiKeyStdin: true, nonInteractive: true });
      expect(result.stored).toBe('keychain');
    } finally {
      stdin.isTTY = original.isTTY;
      stdin[Symbol.asyncIterator] = original.iter;
    }
    expect(FakeEntry.store.get('gherkin-ai-cli/openai')).toBe('sk-secret-123');
    expect(fs.readFileSync(process.env.GHK_USER_CONFIG!, 'utf8')).not.toContain('sk-secret');

    const { removed } = await handleLogoutCommand({ provider: 'openai' });
    expect(removed).toEqual(['openai']);
    expect(FakeEntry.store.size).toBe(0);
  });
});
