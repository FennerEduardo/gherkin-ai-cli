import { describe, it, expect } from 'vitest';
import { executeSandbox, scrubCredentialEnv } from '../../src/core/execution-sandbox';

// M-04: code an agent wrote must not read the user's LLM, cloud or registry credentials from its environment.
describe('credentials in the host environment of agent-driven runs', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk', AZURE_OPENAI_API_KEY: 'az', GEMINI_API_KEY: 'g', AWS_SECRET_ACCESS_KEY: 'aws',
    AWS_SESSION_TOKEN: 't', GITHUB_TOKEN: 'gh', NPM_TOKEN: 'npm', GOOGLE_APPLICATION_CREDENTIALS: '/key.json',
    PATH: '/usr/bin', HOME: '/home/dev', DATABASE_URL: 'postgres://u:p@db/app', JWT_SECRET: 'test-only', NODE_ENV: 'test'
  };

  it('drops provider, cloud and registry credentials and keeps what tests use', () => {
    expect(Object.keys(scrubCredentialEnv(env)).sort()).toEqual(['DATABASE_URL', 'HOME', 'JWT_SECRET', 'NODE_ENV', 'PATH']);
  });

  it('a host run with scrubCredentials does not see them', () => {
    const had = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = had ?? 'sk-probe';
    try {
      const script = `node -e "process.stdout.write(String(Boolean(process.env.OPENAI_API_KEY)))"`;
      expect(executeSandbox({ command: script, scrubCredentials: true }).stdout).toBe('false');
      expect(executeSandbox({ command: script }).stdout).toBe('true');
    } finally {
      if (had === undefined) delete process.env.OPENAI_API_KEY;
    }
  });
});
