import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBenchTask, loadBenchTask, renderBenchMarkdown, runBenchmark } from '../../src/core/bench/harness';

let root: string;
let task: string;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(task, rel)), { recursive: true });
  fs.writeFileSync(path.join(task, rel), content);
};

// The fake agent records its arm, whether it could see the specs, and whether the hidden tests leaked in.
const AGENT = `node -e "const fs=require('fs');fs.writeFileSync('answer.txt',[process.env.GHK_BENCH_ARM,fs.existsSync('features'),fs.existsSync('acceptance-check.js')].join(','))"`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-bench-test-'));
  task = path.join(root, 'task');
  write('bench.json', JSON.stringify({
    name: 'fake',
    agent: AGENT,
    checks: { test: `node -e "require('fs').existsSync('answer.txt')||process.exit(1)"`, acceptance: 'node acceptance-check.js' },
    arms: [
      { name: 'control', specs: false, prepare: [] },
      { name: 'ghk', specs: true, prepare: [], promptAddendum: 'Use the specs.' }
    ]
  }));
  write('REQUIREMENTS.md', '# Build the thing\n');
  write('features/thing.feature', 'Feature: Thing\n  Scenario: Works\n    Given a thing\n    When it runs\n    Then it works\n');
  write('seed/package.json', '{"name":"seed"}');
  write('acceptance/acceptance-check.js', `const [arm, specs, leaked] = require('fs').readFileSync('answer.txt', 'utf8').split(','); process.exit(arm === 'ghk' && specs === 'true' && leaked === 'false' ? 0 : 1);`);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('A/B benchmark harness', () => {
  it('runs every arm with the same agent and scores them with hidden acceptance tests', () => {
    const outDir = path.join(root, 'out');
    const report = runBenchmark(task, { repetitions: 2, workDir: path.join(root, 'work'), outDir });
    expect(report.runs).toHaveLength(4);
    expect(report.summary.control).toMatchObject({ runs: 2, testPassRate: 1, acceptancePassRate: 0 });
    expect(report.summary.ghk).toMatchObject({ runs: 2, testPassRate: 1, acceptancePassRate: 1 });
    const ghkRun = report.runs.find(r => r.arm === 'ghk')!;
    expect(fs.readFileSync(path.join(ghkRun.workspace, 'PROMPT.md'), 'utf8')).toMatch(/Build the thing[\s\S]*Use the specs\./);
    expect(fs.existsSync(path.join(ghkRun.workspace, 'package.json'))).toBe(true);
    expect(ghkRun.filesChanged).toBe(1);
    expect(typeof ghkRun.convergence).toBe('number');
    expect(fs.existsSync(path.join(outDir, 'report.json'))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8')).toContain('| Hidden acceptance tests pass | 0% | 100% |');
  });

  it('prepares workspaces without running the agent in a dry run', () => {
    const report = runBenchmark(task, { dryRun: true, arms: ['ghk'], workDir: path.join(root, 'work') });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].agent).toBeUndefined();
    expect(fs.existsSync(path.join(report.runs[0].workspace, 'features', 'thing.feature'))).toBe(true);
    expect(fs.existsSync(path.join(report.runs[0].workspace, 'answer.txt'))).toBe(false);
    expect(renderBenchMarkdown(report)).toContain('dry run');
  });

  it('scaffolds and validates task folders', () => {
    const dir = path.join(root, 'new-task');
    expect(initBenchTask(dir)).toEqual(expect.arrayContaining(['bench.json', 'REQUIREMENTS.md', 'features/README.md', 'acceptance/README.md']));
    expect(loadBenchTask(dir).repetitions).toBe(3);
    fs.rmSync(path.join(dir, 'REQUIREMENTS.md'));
    expect(() => loadBenchTask(dir)).toThrow(/REQUIREMENTS\.md/);
    expect(() => loadBenchTask(root)).toThrow(/bench\.json/);
  });
});
