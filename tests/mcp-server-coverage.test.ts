import { describe, it, expect } from 'vitest';
import { handleInitCommand } from '../src/commands/init';
import { handleLoginCommand } from '../src/commands/login';
import { handleAuditCommand } from '../src/commands/audit';

describe('MCP Server Tool Coverage', () => {

  it('handleInitCommand runs headlessly without prompts', async () => {
    await expect(handleInitCommand({
      projectName: 'mcp-test-app',
      language: 'typescript',
      framework: 'nestjs',
      nonInteractive: true,
      yes: true
    })).resolves.not.toThrow();
  });

  it('handleLoginCommand runs headlessly without prompts', async () => {
    const auth = await handleLoginCommand({
      token: 'mcp_token_77',
      provider: 'openai',
      nonInteractive: true,
      yes: true
    });
    expect(auth.token).toBe('mcp_token_77');
  });

  it('handleAuditCommand queries inventory without throwing', async () => {
    await expect(handleAuditCommand({
      json: true
    })).resolves.not.toThrow();
  });
});
