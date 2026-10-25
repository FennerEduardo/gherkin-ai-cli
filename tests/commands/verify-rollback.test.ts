import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The tests always fail and the agent keeps proposing the same change: the circuit breaker ends the loop.
const sandboxRuns: any[] = [];
vi.mock('../../src/core/execution-sandbox', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/execution-sandbox')>()),
  executeSandbox: (opts: any) => {
    sandboxRuns.push(opts);
    return { success: false, exitCode: 1, stdout: 'FAIL src/app.spec.ts\nexpected 2 to be 3', stderr: '', durationMs: 1, commandExecuted: 'npm test' };
  }
}));
vi.mock('../../src/core/deterministic-repair', () => ({ planDeterministicRepair: () => null }));
vi.mock('../../src/core/agent-adapter', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/agent-adapter')>()),
  resolveLLMConfig: () => ({ provider: 'test' }),
  RealAgentProvider: class {
    async executeTask() {
      return {
        success: true,
        agentResponse: 'Fixed the sum.',
        tokensUsed: 10,
        codeModifications: [
          { filePath: 'src/app.ts', content: 'export const sum = (a: number, b: number) => a + b + 1;\n' },
          { filePath: 'src/helpers/extra.ts', content: 'export const extra = 1;\n' }
        ]
      };
    }
  }
}));

import { handleVerifyCommand } from '../../src/commands/verify';

describe('verify --auto-fix rollback (N-02)', () => {
  const cwd = process.cwd();
  let dir: string;
  const original = 'export const sum = (a: number, b: number) => a - b;\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-verify-rollback-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), original);
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ projectName: 'calc', stack: { language: 'typescript', framework: 'express' } }));
    process.chdir(dir);
    process.exitCode = undefined;
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('undoes every change when the circuit breaker ends the loop, including created files', async () => {
    await handleVerifyCommand({ autoFix: true, maxRetries: 3, command: 'npm test', allowUnattendedWrites: true, forceBranch: true });
    expect(process.exitCode).toBe(4);
    // The agent's changes were written, then undone.
    const logged = (console.log as any).mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toMatch(/CIRCUIT BREAKER/);
    expect(logged).toMatch(/Rolled back the agent's changes: 1 file\(s\) restored, 1 created file\(s\) removed/);
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(dir, 'src', 'helpers', 'extra.ts'))).toBe(false);
  });

  it('runs the repair loop in the sandbox container unless --host (M-04)', async () => {
    sandboxRuns.length = 0;
    await handleVerifyCommand({ autoFix: true, maxRetries: 1, command: 'npm test', allowUnattendedWrites: true, forceBranch: true });
    expect(sandboxRuns[0]).toMatchObject({ docker: true, scrubCredentials: true });

    sandboxRuns.length = 0;
    await handleVerifyCommand({ autoFix: true, maxRetries: 1, command: 'npm test', allowUnattendedWrites: true, forceBranch: true, host: true });
    expect(sandboxRuns[0]).toMatchObject({ docker: false, scrubCredentials: true });

    sandboxRuns.length = 0;
    await handleVerifyCommand({ command: 'npm test' });
    expect(sandboxRuns[0]).toMatchObject({ docker: false, scrubCredentials: false });
  });

  it('with --feature, writes outside the feature impact scope become proposals', async () => {
    fs.mkdirSync(path.join(dir, 'features'));
    fs.writeFileSync(path.join(dir, 'features', 'refunds.feature'), 'Feature: Refunds\n  Scenario: Refund an order\n    Given a paid order\n    When the clerk refunds the order\n    Then the order is refunded\n');
    await handleVerifyCommand({ autoFix: true, maxRetries: 2, command: 'npm test', allowUnattendedWrites: true, forceBranch: true, feature: 'features/refunds.feature' });
    expect(fs.readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8')).toBe(original);
    // Without --feature the same write is allowed (first test): the scope made the difference.
    expect(fs.existsSync(path.join(dir, '.ghe', 'patches', 'src__app.ts.patch'))).toBe(true);
  });

  it('rejects a --feature that does not exist', async () => {
    await expect(handleVerifyCommand({ autoFix: true, command: 'npm test', feature: 'features/missing.feature' })).rejects.toMatchObject({ exitCode: 2 });
  });

  it('records no made-up requirement coverage', async () => {
    await handleVerifyCommand({ autoFix: true, maxRetries: 3, command: 'npm test', allowUnattendedWrites: true, forceBranch: true });
    const metrics = JSON.parse(fs.readFileSync(path.join(dir, '.ghe', 'execution', 'metrics.json'), 'utf8'));
    expect(metrics).toMatchObject({ requirementCoveragePct: null, requirementCoverageMethod: 'unavailable' });
  });
});
