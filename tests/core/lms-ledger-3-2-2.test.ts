/* ==========================================================================
   LMS ledger items that 3.2.1 still had (PLAN-3.2.2 §3.C)

   P-01  quality measured coverage with a fixed command, so a service whose
         integration tests need a database was measured on its unit tests.
   P-02  `npm test -- --coverage` reaches only the last command of a chained script.
   P-05  generation.exclude "openapi.json" also excluded contracts/<feature>/openapi.json,
         and there was no way to refresh only the contracts.
   M-10  risk --base left out files not yet added to git.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCoverage, coverageToolForReport } from '../../src/core/coverage-integration';
import { planWrites } from '../../src/core/write-protection';
import { resolveChangeSet } from '../../src/core/risk-engine';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { matchesGlob } from '../../src/utils/glob';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-ledger-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = (patch: Partial<GherkinAIConfig>): GherkinAIConfig => ({ ...defaultConfig, ...patch, rules: { ...defaultConfig.rules, coverageTarget: 80 } });

describe('P-01: coverage.command and coverage.report', () => {
  const writeSummary = (pct: number) =>
    `node -e "const fs=require('fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/coverage-summary.json',JSON.stringify({total:{lines:{pct:${pct}}}}))"`;

  it('runs the configured command and reads the configured report', () => {
    const result = runCoverage(dir, config({ coverage: { command: writeSummary(91), report: 'reports/coverage-summary.json' } }));
    expect(result).toMatchObject({ success: true, coveragePercentage: 91, commandSource: 'config', toolUsed: 'Istanbul/c8 (Jest/Vitest)', exitCode: 0 });
  });

  it('a failing configured command still fails, whatever report is on disk', () => {
    fs.mkdirSync(path.join(dir, 'reports'));
    fs.writeFileSync(path.join(dir, 'reports', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 99 } } }));
    const result = runCoverage(dir, config({ coverage: { command: 'node -e "process.exit(3)"', report: 'reports/coverage-summary.json' } }));
    expect(result).toMatchObject({ success: false, exitCode: 3, commandSource: 'config' });
  });

  it('needs both keys and a known report format', () => {
    expect(runCoverage(dir, config({ coverage: { command: 'true' } })).errorMessage).toMatch(/go together/);
    expect(runCoverage(dir, config({ coverage: { command: 'true', report: 'cov.lcov' } })).errorMessage).toMatch(/Unknown coverage report format/);
  });

  it('infers the format from the report name', () => {
    expect(coverageToolForReport('target/site/jacoco/jacoco.csv')).toBe('JaCoCo');
    expect(coverageToolForReport('coverage/coverage-summary.json')).toBe('Istanbul/c8 (Jest/Vitest)');
    expect(coverageToolForReport('coverage.json')).toBe('coverage.py (pytest)');
    expect(coverageToolForReport('coverage-summary.txt')).toBe('go tool cover');
  });
});

describe('P-02: chained npm test scripts', () => {
  it('warns that the coverage flags reach only the last command', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest && cucumber-js' } }));
    const result = runCoverage(dir, config({ stack: { ...defaultConfig.stack, language: 'typescript' } }));
    expect(result.warning).toMatch(/chains commands/);
  });
});

describe('P-05: generation.exclude anchored at the root, and --contracts-only', () => {
  const artifacts = [
    { filePath: 'openapi.json', content: '{}' },
    { filePath: 'contracts/orders/openapi.json', content: '{}' },
    { filePath: 'src/runtime/command-service.ts', content: 'x' },
  ];
  const plan = (extra: Partial<Parameters<typeof planWrites>[1]>) =>
    Object.fromEntries(planWrites(artifacts, { cwd: dir, outputDir: './', inventory: [], ...extra }).map(p => [p.filePath, p.action]));

  it('a leading slash excludes only the root file, as in .gitignore', () => {
    expect(matchesGlob('openapi.json', '/openapi.json')).toBe(true);
    expect(matchesGlob('contracts/orders/openapi.json', '/openapi.json')).toBe(false);
    expect(plan({ exclude: ['/openapi.json'] })).toMatchObject({ 'openapi.json': 'skipped', 'contracts/orders/openapi.json': 'create' });
  });

  it('a pattern without a slash still matches at any depth', () => {
    expect(plan({ exclude: ['openapi.json'] })).toMatchObject({ 'openapi.json': 'skipped', 'contracts/orders/openapi.json': 'skipped' });
  });

  it('--contracts-only writes the contracts and skips everything else', () => {
    expect(plan({ contractsOnly: true })).toEqual({ 'openapi.json': 'create', 'contracts/orders/openapi.json': 'create', 'src/runtime/command-service.ts': 'skipped' });
  });
});

describe('M-10: risk --base counts new files', () => {
  it('includes untracked files in the change set', () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'new-endpoint.ts'), 'b');
    expect(resolveChangeSet(dir, { base: 'main' })).toEqual({ basis: 'git-diff', files: ['new-endpoint.ts'] });
  });
});
