import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadResolvedConfig, defaultConfig } from '../../src/core/config';
import { ConfigError, ExitCode } from '../../src/core/errors';

describe('Layered configuration loader', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-config-'));
    env = {
      GHK_ORG_CONFIG: path.join(dir, 'org.json'),
      GHK_USER_CONFIG: path.join(dir, 'user.json')
    };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns defaults when no layer exists', () => {
    const resolved = loadResolvedConfig({ cwd: dir, env });
    expect(resolved.config.projectName).toBe(defaultConfig.projectName);
    expect(resolved.projectConfigFound).toBe(false);
    expect(resolved.layers.map(l => l.name)).toEqual(['defaults', 'environment']);
  });

  it('applies precedence org < user < project < env and tracks sources', () => {
    write('org.json', { llm: { provider: 'azure-openai', timeoutMs: 1000 } });
    write('user.json', { llm: { timeoutMs: 2000 }, locale: 'es' });
    write('gherkin-ai.config.json', { projectName: 'billing', stack: { framework: 'express' } });
    env.LLM_MODEL = 'gpt-4.1';

    const { config, sources } = loadResolvedConfig({ cwd: dir, env });
    expect(config.projectName).toBe('billing');
    expect(config.stack.framework).toBe('express');
    expect(config.stack.language).toBe('typescript'); // deep merge keeps defaults
    expect(config.llm).toMatchObject({ provider: 'azure-openai', timeoutMs: 2000, model: 'gpt-4.1' });
    expect(sources['llm.provider']).toBe('organization');
    expect(sources['llm.timeoutMs']).toBe('user');
    expect(sources['projectName']).toBe('project');
    expect(sources['llm.model']).toBe('environment');
  });

  it('enforces organization-locked paths and warns about ignored overrides', () => {
    write('org.json', { llm: { allowedProviders: ['azure-openai'] }, telemetry: { enabled: true }, locked: ['llm.allowedProviders', 'telemetry.enabled'] });
    write('gherkin-ai.config.json', { llm: { allowedProviders: ['openai'] } });
    env.GHK_TELEMETRY_DISABLED = 'true';

    const { config, warnings, sources } = loadResolvedConfig({ cwd: dir, env });
    expect(config.llm?.allowedProviders).toEqual(['azure-openai']);
    expect(config.telemetry?.enabled).toBe(true);
    expect(sources['llm.allowedProviders']).toBe('organization');
    expect(warnings.some(w => w.includes('llm.allowedProviders') && w.includes('project'))).toBe(true);
    expect(warnings.some(w => w.includes('telemetry.enabled') && w.includes('environment'))).toBe(true);
  });

  it('ignores `locked` declared outside the organization layer', () => {
    write('gherkin-ai.config.json', { llm: { provider: 'openai' }, locked: ['llm.provider'] });
    env.LLM_PROVIDER = 'anthropic';
    const { config } = loadResolvedConfig({ cwd: dir, env });
    expect(config.llm?.provider).toBe('anthropic');
  });

  it('throws ConfigError with field paths on schema violations', () => {
    write('gherkin-ai.config.json', { architecture: 'spaghetti', rules: { coverageTarget: 150 } });
    try {
      loadResolvedConfig({ cwd: dir, env });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).exitCode).toBe(ExitCode.CONFIG);
      expect((err as Error).message).toContain('architecture');
      expect((err as Error).message).toContain('rules.coverageTarget');
    }
  });

  it('rejects invalid environment values', () => {
    env.LLM_PROVIDER = 'not-a-provider';
    expect(() => loadResolvedConfig({ cwd: dir, env })).toThrow(/environment variables/);
  });

  it('reports malformed JSON and unknown keys', () => {
    write('gherkin-ai.config.json', '{ not json');
    expect(() => loadResolvedConfig({ cwd: dir, env })).toThrow(ConfigError);

    write('gherkin-ai.config.json', { projectName: 'x', mysteryKey: true });
    const { warnings } = loadResolvedConfig({ cwd: dir, env });
    expect(warnings.some(w => w.includes('mysteryKey'))).toBe(true);
  });

  it('fails on an explicitly required but missing project config', () => {
    expect(() => loadResolvedConfig({ cwd: dir, env, configPath: 'missing.json', requireProject: true })).toThrow(/not found/);
    expect(() => loadResolvedConfig({ cwd: dir, env, configPath: 'missing.json' })).not.toThrow();
  });

  it('maps provider-specific environment variables', () => {
    Object.assign(env, {
      AZURE_OPENAI_ENDPOINT: 'https://corp.openai.azure.com',
      AZURE_OPENAI_DEPLOYMENT: 'gpt4o-prod',
      OPENAI_API_VERSION: '2024-10-21',
      AWS_REGION: 'eu-west-1',
      GOOGLE_CLOUD_PROJECT: 'acme',
      GOOGLE_CLOUD_LOCATION: 'europe-west4'
    });
    const { config } = loadResolvedConfig({ cwd: dir, env });
    expect(config.llm?.azure).toEqual({ endpoint: 'https://corp.openai.azure.com', deployment: 'gpt4o-prod', apiVersion: '2024-10-21' });
    expect(config.llm?.bedrock?.region).toBe('eu-west-1');
    expect(config.llm?.vertex).toEqual({ project: 'acme', location: 'europe-west4' });
  });
});
