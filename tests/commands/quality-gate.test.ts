import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleQualityCommand } from '../../src/commands/quality';
import { resetOutputState } from '../../src/utils/output';

// LMS evidence report E-14: notification-service passed the gate (exit 0) because its tests failed and no
// coverage could be read. Missing data must never count as a pass.
const SUMMARY = (pct: number) => JSON.stringify({ total: { lines: { pct } } });

describe('ghk quality gate without coverage data', () => {
  const cwd = process.cwd();
  let dir: string;
  let out: string;

  /** A project whose `npm test` runs `body` (a script file: npm appends --coverage, which `node -e` would reject). */
  const project = (body: string) => {
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ projectName: 'notify', stack: { language: 'typescript', framework: 'nestjs' }, rules: { coverageTarget: 80 } }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'notify', private: true, scripts: { test: 'node fake-tests.js' } }));
    fs.writeFileSync(path.join(dir, 'fake-tests.js'), body);
  };
  const quality = async (opts = {}) => {
    out = '';
    resetOutputState();
    await handleQualityCommand({ json: true, ...opts });
    return JSON.parse(out);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-quality-'));
    process.chdir(dir);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out += String(chunk); return true; });
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the tests fail, even with a good report from an earlier run', async () => {
    project('process.exit(1);');
    fs.mkdirSync(path.join(dir, 'coverage'));
    fs.writeFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), SUMMARY(95));

    const r = await quality();
    expect(r.gatePassed).toBe(false);
    expect(process.exitCode).toBe(4);
    expect(r.coverage).toMatchObject({ available: false, percentage: null, exitCode: 1 });
    expect(r.reasons.join('\n')).toMatch(/Tests failed/);
    // --allow-missing-coverage never excuses failing tests.
    expect((await quality({ allowMissingCoverage: true })).reasons.join('\n')).toMatch(/Tests failed/);
  });

  it('fails when no coverage report is produced, unless --allow-missing-coverage', async () => {
    project('process.exit(0);');
    const r = await quality();
    expect(r.gatePassed).toBe(false);
    expect(r.reasons.join('\n')).toMatch(/Coverage unavailable/);
    expect((await quality({ allowMissingCoverage: true })).reasons.join('\n')).not.toMatch(/Coverage/);
  });

  it('reads the report the tests just wrote and records how it was measured', async () => {
    project(`const fs = require('fs'); fs.mkdirSync('coverage', { recursive: true }); fs.writeFileSync('coverage/coverage-summary.json', ${JSON.stringify(SUMMARY(91))});`);
    const r = await quality();
    expect(r.coverage).toMatchObject({ available: true, percentage: 91, exitCode: 0 });
    expect(r.coverage.command).toMatch(/npm test/);
    expect(r.coverage.reportMtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.reasons.join('\n')).not.toMatch(/overage|Tests failed/);
  });

  it('without a change set, reports the risk but does not gate on it, and uses the measured coverage (E-12)', async () => {
    project(`const fs = require('fs'); fs.mkdirSync('coverage', { recursive: true }); fs.writeFileSync('coverage/coverage-summary.json', ${JSON.stringify(SUMMARY(92))});`);
    fs.mkdirSync(path.join(dir, 'features'));
    fs.writeFileSync(path.join(dir, 'features', 'login.feature'), [
      'Feature: Login', '  Scenario: Authenticate with a password and a JWT token', '    Given a user with a password',
      '    When the user logs in with the password', '    Then a JWT session token is issued for the tenant', '    And the payment permissions are checked'
    ].join('\n'));
    const r = await quality();
    expect(r.risk.basis).toBe('specification');
    expect(r.risk.gating).toBe(false);
    expect(r.risk.dimensions.find((d: any) => d.id === 'testWeakness').evidence.join(' ')).toMatch(/92% \(measured by this run\)/);
    expect(r.gatePassed, r.reasons.join('\n')).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
