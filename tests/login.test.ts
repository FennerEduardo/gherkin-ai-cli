import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleLoginCommand, getAuthConfig, saveAuthConfig } from '../src/commands/login';
import fs from 'fs';
import path from 'path';

describe('Login & Auth Configuration Command', () => {
  const tempWorkspace = path.join(__dirname, 'temp-login-workspace');

  beforeEach(() => {
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
    fs.mkdirSync(tempWorkspace, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempWorkspace)) {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it('saveAuthConfig saves auth payload into .gherkin-ai/auth.json', () => {
    const authData = {
      token: 'tok_test_123',
      user: 'dev@company.local',
      provider: 'anthropic',
      apiKey: 'sk-ant-test'
    };

    const savedPath = saveAuthConfig(authData, tempWorkspace);
    expect(fs.existsSync(savedPath)).toBe(true);

    const loaded = getAuthConfig(tempWorkspace);
    expect(loaded).not.toBeNull();
    expect(loaded?.token).toBe('tok_test_123');
    expect(loaded?.provider).toBe('anthropic');
  });

  it('handleLoginCommand executes headlessly and returns auth config', async () => {
    const config = await handleLoginCommand({
      token: 'tok_headless_999',
      user: 'agent-bot',
      provider: 'gemini',
      apiKey: 'sk-gemini-key',
      nonInteractive: true
    });

    expect(config.token).toBe('tok_headless_999');
    expect(config.provider).toBe('gemini');
  });
});
