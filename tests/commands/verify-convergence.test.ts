import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The test run itself passes; what is under test is what verify does afterwards.
vi.mock('../../src/core/execution-sandbox', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/core/execution-sandbox')>()),
  executeSandbox: () => ({ success: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, commandExecuted: 'npm test' })
}));

import { handleVerifyCommand } from '../../src/commands/verify';

describe('verify after passing tests', () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-verify-'));
    fs.mkdirSync(path.join(dir, 'features'));
    fs.writeFileSync(path.join(dir, 'features', 'orders.feature'), 'Feature: Orders\n  Scenario: Place an order\n    Given a cart\n    When the customer places the order\n    Then the order is placed\n');
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ projectName: 'orders', stack: { language: 'typescript', framework: 'nestjs' } }));
    process.chdir(dir);
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports convergence without failing when no threshold is given', async () => {
    await handleVerifyCommand({ command: 'npm test' });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('fails with the drift exit code below --converge-threshold', async () => {
    await handleVerifyCommand({ command: 'npm test', convergeThreshold: '101' });
    expect(process.exitCode).toBe(7);
  });

  it('passes at or above --converge-threshold', async () => {
    await handleVerifyCommand({ command: 'npm test', convergeThreshold: '0' });
    expect(process.exitCode ?? 0).toBe(0);
  });
});
