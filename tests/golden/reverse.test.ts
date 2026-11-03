/* ==========================================================================
   Golden: `ghk reverse` on existing repositories (PLAN-3.3.0 §4)

   Black box, like the brownfield governance golden: the built binary, stdin
   closed, no `ghk init`, on services gherkin-ai never generated. For each:
   - `reverse scan --json` and `reverse propose` exit 0 and report beta analyzers;
   - the proposal passes `ghk lint --threshold 80` and declares the expected commands;
   - nothing is written outside .ghe/reverse (git status stays clean);
   - two runs produce byte-identical output;
   - usage errors exit 2, a proposal below --threshold exits 4.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BIN = path.resolve(__dirname, '../../bin/gherkin-ai.js');
const DIST = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

const STACKS = [
  { fixture: 'golden/brownfield-express', analyzer: 'typescript/express', commands: ['@command:CancelOrder', '@command:PlaceOrder'] },
  { fixture: 'reverse/nestjs-orders', analyzer: 'typescript/nestjs', commands: ['@command:ApproveOrder', '@command:PlaceOrder'] },
  { fixture: 'golden/brownfield-spring', analyzer: 'jvm/spring-quarkus', commands: ['@command:CancelOrder', '@command:PlaceOrder'] },
  { fixture: 'reverse/spring-kotlin-invoices', analyzer: 'jvm/spring-quarkus', commands: ['@command:IssueInvoice', '@command:PayInvoice'], proposal: 'invoice.feature' },
  { fixture: 'reverse/quarkus-payments', analyzer: 'jvm/spring-quarkus', commands: ['@command:InitiatePayment', '@command:SettlePayment'], proposal: 'payment.feature' },
  { fixture: 'reverse/aspnet-orders', analyzer: 'csharp/aspnet', maturity: 'beta', commands: ['@command:CancelOrder', '@command:PlaceOrder'] },
  { fixture: 'reverse/fastapi-orders', analyzer: 'python/fastapi', maturity: 'beta', commands: ['@command:CancelOrder', '@command:PlaceOrder'] },
  { fixture: 'reverse/go-orders', analyzer: 'go/http', maturity: 'beta', commands: ['@command:CancelOrder', '@command:PlaceOrder'] }
];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function parseJson(stdout: string): any {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`No JSON on stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(start));
}

describe.skipIf(!fs.existsSync(DIST)).each(STACKS)('golden: ghk reverse on $fixture', stack => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const run = (...args: string[]) => {
    const res = spawnSync(process.execPath, [BIN, ...args, '--project', dir], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 120_000 });
    return { code: res.status, stdout: res.stdout, out: `${res.stdout}\n${res.stderr}` };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-golden-reverse-'));
    fs.cpSync(path.join(FIXTURES, stack.fixture), dir, { recursive: true });
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GHK_|LLM_|OPENAI|ANTHROPIC|GEMINI|AZURE_OPENAI|CI$)/.test(k)));
    env = { ...clean, NO_COLOR: '1', GHK_LOCALE: 'en', GHK_USER_CONFIG: path.join(dir, '..', `${path.basename(dir)}-user.json`), GHK_ORG_CONFIG: path.join(dir, '..', `${path.basename(dir)}-org.json`) };
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=golden', '-c', 'user.email=golden@example.com', 'commit', '-q', '-m', 'existing service');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scans, proposes a feature that passes lint, and leaves the repository untouched', () => {
    const scan = run('reverse', 'scan', '--json');
    expect(scan.code, scan.out).toBe(0);
    const report = parseJson(scan.stdout);
    expect(report.status).toBe('beta');
    expect(report.analyzers).toEqual(expect.arrayContaining([expect.objectContaining({ id: stack.analyzer, maturity: stack.maturity ?? 'beta' })]));

    const propose = run('reverse', 'propose');
    expect(propose.code, propose.out).toBe(0);
    const proposal = path.join('.ghe', 'reverse', 'proposals', stack.proposal ?? 'order.feature');
    const text = fs.readFileSync(path.join(dir, proposal), 'utf8');
    for (const tag of stack.commands) expect(text).toContain(tag);

    const lint = run('lint', '-f', proposal, '--threshold', '80');
    expect(lint.code, lint.out).toBe(0);

    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('is deterministic across runs', () => {
    run('reverse', 'scan');
    run('reverse', 'propose');
    const first = fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'proposals', stack.proposal ?? 'order.feature'), 'utf8') + fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'scan.json'), 'utf8');
    run('reverse', 'propose', '--rescan');
    const second = fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'proposals', stack.proposal ?? 'order.feature'), 'utf8') + fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'scan.json'), 'utf8');
    expect(second).toBe(first);
  });

  it('accept writes only with --yes; coverage reports the share the features specify', () => {
    run('reverse', 'propose');
    const aggregate = (stack.proposal ?? 'order.feature').replace(/\.feature$/, '');
    expect(run('reverse', 'accept', aggregate).code).toBe(2);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const before = parseJson(run('reverse', 'coverage', '--json').stdout).coverage.percent;
    const accepted = run('reverse', 'accept', '--all', '--yes', '--merge');
    expect([0, 7], accepted.out).toContain(accepted.code);
    const after = run('reverse', 'coverage', '--json', '--min', '100');
    expect(after.code, after.out).toBe(0);
    expect(parseJson(after.stdout).coverage.percent).toBeGreaterThanOrEqual(before);
  });

  it('exits 2 on usage errors and 4 when a proposal is below the threshold', () => {
    expect(run('reverse').code).toBe(2);
    expect(run('reverse', 'propose', '--min-confidence', 'maybe').code).toBe(2);
    expect(run('reverse', 'propose', '--threshold', '100').code).toBe(4);
  });
});
