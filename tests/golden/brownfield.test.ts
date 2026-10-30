/* ==========================================================================
   Golden: governance commands on an existing repository (no `ghk init`)

   The fixtures are hand-written services (Express and Spring) with their own
   routes and one .feature, and no gherkin-ai file at all. Every review of
   3.2.1 asked for the governance layer (lint, validate, converge, risk, graph,
   impact, firewall) to work on such a repository. In 3.2.1 detect crashed
   without a TTY, validate assumed NestJS + Prisma, converge exited 7 on
   dimensions that did not apply, implement exited 0 on a missing feature, and
   the read-only commands left untracked files behind (PLAN-3.2.2 §3.A).

   Black-box: runs the built binary with stdin closed, as a CI job does.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BIN = path.resolve(__dirname, '../../bin/gherkin-ai.js');
const DIST = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'golden');

const STACKS = [
  { fixture: 'brownfield-express', language: 'javascript', framework: 'express', source: 'src/orders.js', foreign: /nestjs|prisma/i },
  { fixture: 'brownfield-spring', language: 'java', framework: 'spring-boot', source: 'src/main/java/com/shop/orders/OrderController.java', foreign: /nestjs|prisma|typescript/i }
];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** The first JSON document on stdout (some commands print a banner on stderr only). */
function parseJson(stdout: string): any {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`No JSON on stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

describe.skipIf(!fs.existsSync(DIST)).each(STACKS)('golden: $fixture without ghk init', stack => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const run = (...args: string[]) => {
    const res = spawnSync(process.execPath, [BIN, ...args, '--project', dir], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 120_000 });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr, out: `${res.stdout}\n${res.stderr}` };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `ghk-golden-${stack.fixture}-`));
    fs.cpSync(path.join(FIXTURES, stack.fixture), dir, { recursive: true });
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GHK_|LLM_|OPENAI|ANTHROPIC|GEMINI|AZURE_OPENAI|CI$)/.test(k)));
    env = {
      ...clean,
      NO_COLOR: '1',
      GHK_LOCALE: 'en',
      GHK_USER_CONFIG: path.join(dir, '..', `${path.basename(dir)}-user.json`),
      GHK_ORG_CONFIG: path.join(dir, '..', `${path.basename(dir)}-org.json`),
      GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@example.com', GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@example.com'
    };
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=golden', '-c', 'user.email=golden@example.com', 'commit', '-q', '-m', 'existing service');
    // The change under review: one edited source file.
    fs.appendFileSync(path.join(dir, stack.source), '\n// reviewed change\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detect answers without a TTY and reports the real stack (BF-01)', () => {
    const res = run('detect', '--json');
    expect(res.code, res.out).toBe(0);
    expect(parseJson(res.stdout)).toMatchObject({ language: stack.language, framework: stack.framework });
  });

  it('validate uses the detected stack when there is no configuration (BF-02)', () => {
    const res = run('validate');
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain(stack.framework);
    expect(res.out).not.toMatch(stack.foreign);
  });

  it('converge leaves out what a repository without gherkin-ai artifacts cannot be measured on (BF-03)', () => {
    const res = run('converge', '--json');
    const [report] = parseJson(res.stdout);
    const dim = (name: string) => report.dimensions.find((d: any) => d.name === name);
    expect(dim('Contract Coverage').applicable, JSON.stringify(dim('Contract Coverage'))).toBe(false);
    expect(dim('Architecture Compliance').applicable, JSON.stringify(dim('Architecture Compliance'))).toBe(false);
    // The exit code follows the score of the dimensions that were measured.
    expect(res.code, res.out).toBe(report.overallConvergence >= 80 && !report.contractDrift ? 0 : 7);
  });

  it('converge --openapi measures contract coverage against the repository\'s own contract (BF-03)', () => {
    if (!fs.existsSync(path.join(dir, 'docs', 'openapi.json'))) return;
    const res = run('converge', '--json', '--openapi', 'docs/openapi.json');
    const [report] = parseJson(res.stdout);
    const contract = report.dimensions.find((d: any) => d.name === 'Contract Coverage');
    expect(contract.applicable, JSON.stringify(contract)).not.toBe(false);
  });

  it('feature names resolve the same way everywhere; a missing feature is a usage error (BF-04)', () => {
    expect(run('impact', '-f', 'orders').code).toBe(0);
    const missing = run('implement', '-f', 'payments');
    expect(missing.code, missing.out).toBe(2);
    expect(missing.out).toContain('orders');
    expect(missing.out).not.toMatch(/Preparando|01-customer-management/);
    expect(run('impact', '-f', 'payments').code).toBe(2);
  });

  it('risk scores the working-tree change (BF-02)', () => {
    const res = run('risk', '--json');
    expect(res.code, res.out).toBe(0);
    expect(parseJson(res.stdout)).toMatchObject({ basis: 'working-tree' });
  });

  it('firewall check takes a positional command (BF-07)', () => {
    expect(run('firewall', 'check', 'cat .env').code).toBe(5);
    expect(run('firewall', 'check', 'git status').code).toBe(0);
  });

  it('lint and converge fail with a usage error when there is no feature (BF-06)', () => {
    fs.rmSync(path.join(dir, 'features'), { recursive: true });
    for (const command of ['lint', 'converge']) {
      const res = run(command);
      expect(res.code, `${command}: ${res.out}`).toBe(2);
    }
    expect(run('lint', '--allow-empty').code).toBe(0);
  });

  it('leaves nothing behind but the change under review (BF-05)', () => {
    for (const args of [['lint'], ['validate'], ['converge'], ['risk'], ['graph'], ['impact', '-f', 'orders'], ['detect', '--json']]) run(...args);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir }).toString();
    expect(status.split('\n').filter(Boolean)).toEqual([` M ${stack.source}`]);
  });
});
