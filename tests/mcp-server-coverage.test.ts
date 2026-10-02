import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleInitCommand } from '../src/commands/init';
import { handleAuditCommand } from '../src/commands/audit';

describe('MCP Server Tool Coverage', () => {
  // init writes config, governance and CI files into the cwd: never run it in the repository root.
  let cwd: string;
  let dir: string;

  beforeAll(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-mcp-coverage-'));
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handleInitCommand runs headlessly without prompts', async () => {
    await expect(handleInitCommand({
      projectName: 'mcp-test-app',
      language: 'typescript',
      framework: 'nestjs',
      nonInteractive: true,
      yes: true
    })).resolves.not.toThrow();
    expect(fs.existsSync(path.join(dir, 'gherkin-ai.config.json'))).toBe(true);
  });

  it('generates a CI gate that pins the CLI version', () => {
    const workflow = fs.readFileSync(path.join(dir, '.github', 'workflows', 'gherkin-ai-gate.yml'), 'utf8');
    expect(workflow).toMatch(/GHK_VERSION: '\d+\.\d+\.\d+/);
    expect(workflow).not.toContain('npm install -g gherkin-ai');
  });

  it('handleAuditCommand queries inventory without throwing', async () => {
    await expect(handleAuditCommand({
      json: true
    })).resolves.not.toThrow();
  });
});
