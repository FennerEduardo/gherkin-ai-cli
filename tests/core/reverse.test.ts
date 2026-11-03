/* ==========================================================================
   `ghk reverse` (beta): evidence, candidates and proposals (PLAN-3.3.0 §3.A)

   Runs the pipeline in-process on hand-written services that gherkin-ai never
   generated: the Express brownfield fixture (shared with the governance
   golden) and a NestJS service with a DTO, guards, roles, a state guard,
   events, a technical failure and an e2e test.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAccept, runCoverage, runPropose, runScan, REVERSE_DIR } from '../../src/core/reverse';
import { similarCommands } from '../../src/core/reverse/dedup';
import { discoverSources, globToRegExp, isSecretPath } from '../../src/core/reverse/discovery';
import { normalisePath, joinPaths } from '../../src/core/reverse/evidence';
import { operationName, participle, thirdPerson, requiredState, aggregateFromEndpoint, singular } from '../../src/core/reverse/candidates';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { handleReverseCommand } from '../../src/commands/reverse';
import { UsageError } from '../../src/core/errors';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function copyFixture(rel: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-reverse-'));
  fs.cpSync(path.join(FIXTURES, rel), dir, { recursive: true });
  // Secrets are never read: a .env with a password sits next to the code (the repository ignores fixture .env files).
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://user:s3cret@localhost/orders\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'existing service');
  return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** Every Then/And-after-Then step is preceded by an `# evidence:` comment. */
function thenStepsWithoutEvidence(text: string): string[] {
  const lines = text.split('\n');
  const missing: string[] = [];
  let inThen = false;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (/^(Given|When)\b/.test(t)) inThen = false;
    if (/^Then\b/.test(t)) inThen = true;
    if (inThen && /^(Then|And|But)\b/.test(t) && !/^\s*# evidence: ev-/.test(lines[i - 1] ?? '')) missing.push(t);
  });
  return missing;
}

describe('reverse helpers', () => {
  it('normalises paths of every framework to {param}', () => {
    expect(normalisePath('/orders/:id/cancel')).toBe('/orders/{id}/cancel');
    expect(normalisePath('orders/<int:pk>/')).toBe('/orders/{pk}');
    expect(joinPaths('api/v1/orders', ':id')).toBe('/api/v1/orders/{id}');
    expect(joinPaths('/orders', undefined)).toBe('/orders');
  });

  it('names operations from operationId, handler or method + path', () => {
    expect(operationName({ method: 'POST', path: '/orders' }, 'Order', 'placeOrder').name).toBe('PlaceOrder');
    expect(operationName({ method: 'POST', path: '/orders/{id}/cancel' }, 'Order')).toMatchObject({ name: 'CancelOrder', verb: 'cancel', type: 'command' });
    expect(operationName({ method: 'POST', path: '/orders', handler: 'create' }, 'Order').name).toBe('CreateOrder');
    expect(operationName({ method: 'GET', path: '/orders', handler: 'findAll' }, 'Order')).toMatchObject({ name: 'ListOrders', type: 'query' });
    expect(operationName({ method: 'GET', path: '/orders/{id}' }, 'Order')).toMatchObject({ name: 'GetOrder', type: 'query' });
    expect(operationName({ method: 'DELETE', path: '/orders/{id}' }, 'Order').name).toBe('DeleteOrder');
    expect(operationName({ method: 'PATCH', path: '/orders/{id}', handler: 'patch' }, 'Order').name).toBe('UpdateOrder');
  });

  it('derives the aggregate from the controller or the first business path segment', () => {
    expect(aggregateFromEndpoint({ method: 'GET', path: '/x', owner: 'OrdersController' })).toBe('Order');
    expect(aggregateFromEndpoint({ method: 'GET', path: '/api/v2/categories/{id}' })).toBe('Category');
    expect(singular('addresses')).toBe('address');
  });

  it('conjugates verbs for steps and outcomes', () => {
    expect([thirdPerson('place'), thirdPerson('apply'), thirdPerson('approve'), thirdPerson('cancel')]).toEqual(['places', 'applies', 'approves', 'cancels']);
    expect([participle('place'), participle('cancel'), participle('submit'), participle('apply'), participle('pay')]).toEqual(['placed', 'cancelled', 'submitted', 'applied', 'paid']);
  });

  it('reads the state a guard requires, literal or enum member', () => {
    expect(requiredState("order.status !== 'PENDING'")).toBe('PENDING');
    expect(requiredState('order.status !== OrderStatus.PENDING')).toBe('PENDING');
    expect(requiredState('!order')).toBeUndefined();
  });

  it('never reads secrets; globs match relative paths', () => {
    expect(['.env', '.env.local', 'config/secrets.yaml', 'certs/server.key', 'id_rsa'].every(isSecretPath)).toBe(true);
    expect(isSecretPath('src/environment.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('**/*.spec.ts').test('src/a.spec.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe.each([
  { fixture: 'golden/brownfield-express', aggregate: 'Order', commands: ['CancelOrder', 'PlaceOrder'] },
  { fixture: 'reverse/nestjs-orders', aggregate: 'Order', commands: ['ApproveOrder', 'PlaceOrder'] }
])('ghk reverse on $fixture', ({ fixture, aggregate, commands }) => {
  let dir: string;
  beforeEach(() => { clearTsProjects(); dir = copyFixture(fixture); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('proposes a feature per aggregate that recovers the commands, passes lint and round-trips through the IR', async () => {
    const scan = await runScan(dir);
    const result = runPropose(dir, scan);
    expect(result.proposals.map(p => p.aggregate)).toEqual([aggregate]);
    const [p] = result.proposals;
    expect(p.commands.sort()).toEqual(commands);
    expect(p.lint.score, JSON.stringify(p.lint.diagnostics)).toBeGreaterThanOrEqual(80);
    expect(p.roundTrip).toEqual({ ok: true, missingCommands: [] });

    const text = read(dir, path.join(REVERSE_DIR, 'proposals', p.file));
    expect(text).toMatch(/^@reverse-engineered @characterization @needs-review$/m);
    // Lossless: the IR built from the proposal names the same commands.
    const ir = buildIR(parseGherkinText(text), p.file, { mode: 'deterministic' });
    expect(ir.commands.map(c => c.name).sort()).toEqual(commands.map(c => c.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()).sort());
  });

  it('backs every outcome with evidence and never invents data', async () => {
    const result = runPropose(dir, await runScan(dir));
    const text = read(dir, path.join(REVERSE_DIR, 'proposals', result.proposals[0].file));
    expect(thenStepsWithoutEvidence(text)).toEqual([]);
    for (const c of result.candidates) for (const sc of c.scenarios) for (const s of sc.steps) expect(s.evidence.length, `${sc.name}: ${s.text}`).toBeGreaterThan(0);
    // Evidence ids in the proposal all exist in the scan.
    const scan = JSON.parse(read(dir, path.join(REVERSE_DIR, 'scan.json')));
    const ids = new Set(scan.evidence.map((e: any) => e.id));
    for (const id of text.match(/ev-[0-9a-f]{10}/g) ?? []) expect(ids.has(id), id).toBe(true);
  });

  it('writes only inside .ghe/reverse, never reads .env, and leaves git status clean', async () => {
    const scan = await runScan(dir);
    runPropose(dir, scan);
    expect(scan.secretsSkipped).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(scan)).not.toContain('s3cret');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('');
  });

  it('is deterministic: a second run produces byte-identical files', async () => {
    runPropose(dir, await runScan(dir));
    const snapshot = (d: string) => fs.readdirSync(d, { recursive: true }).map(String).sort().map(f => [f, fs.statSync(path.join(d, f)).isFile() ? fs.readFileSync(path.join(d, f), 'utf8') : '']);
    const first = snapshot(path.join(dir, REVERSE_DIR));
    clearTsProjects();
    runPropose(dir, await runScan(dir));
    expect(snapshot(path.join(dir, REVERSE_DIR))).toEqual(first);
  });
});

describe('ghk reverse on the NestJS service', () => {
  let dir: string;
  beforeEach(() => { clearTsProjects(); dir = copyFixture('reverse/nestjs-orders'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('follows the controller into the service: guards, roles, state guard, events and DTO rules', async () => {
    const { candidates, unresolved } = runPropose(dir, await runScan(dir));
    const approve = candidates.find(c => c.operation.name === 'ApproveOrder')!;
    const names = approve.scenarios.map(s => s.name);
    expect(names).toContain('A user without the manager role cannot approve the order');
    expect(names).toContain('An unauthenticated user cannot approve the order');
    expect(names).toContain('Approving the order fails when the order does not exist');
    expect(names).toContain('Approving the order fails when the order is not pending');
    const success = approve.scenarios[0].steps.map(s => `${s.keyword} ${s.text}`);
    expect(success).toEqual(expect.arrayContaining(['And an order with status "PENDING"', 'Then the order is approved', 'And the order status is "APPROVED"', 'And the "OrderApproved" event is published']));
    // The 503 is technical: an open question, never a scenario.
    expect(names.some(n => /unavailable/i.test(n))).toBe(false);
    expect(unresolved.some(q => /Database unavailable/.test(q.question))).toBe(true);

    const place = candidates.find(c => c.operation.name === 'PlaceOrder')!;
    expect(place.events).toEqual(['OrderPlaced']);
    expect(place.scenarios.filter(s => s.category === 'validation').map(s => s.name)).toEqual([
      'Placing an order is rejected when customer email is not a valid email',
      'Placing an order is rejected when items are missing',
      'Placing an order is rejected when quantity is not a whole number'
    ]);
    // The e2e test calls POST /api/v1/orders: the behaviour is confirmed.
    expect(place.confidence).toBe('confirmed');
    expect(candidates.find(c => c.operation.name === 'ListOrders')?.operation.type).toBe('query');
  });

  it('--min-confidence leaves out what is less certain', async () => {
    const scan = await runScan(dir);
    const all = runPropose(dir, scan).proposals[0];
    const confirmed = runPropose(dir, scan, { minConfidence: 'confirmed' }).proposals[0];
    expect(confirmed.scenarios).toBeLessThan(all.scenarios);
    expect(confirmed.dropped).toBe(all.scenarios - confirmed.scenarios);
  });

  it('--scope narrows the proposal to one operation', async () => {
    const result = runPropose(dir, await runScan(dir), { scope: ['ApproveOrder'] });
    expect(result.candidates.map(c => c.operation.name)).toEqual(['ApproveOrder']);
  });

  it('discovery skips build output, dependencies and git-ignored files', () => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), 'app.get("/x", h)');
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp', 'scratch.ts'), '');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'tmp/\n');
    const files = discoverSources(dir).files.map(f => f.rel);
    expect(files).toContain('src/orders/orders.controller.ts');
    expect(files.some(f => f.startsWith('dist/') || f.startsWith('tmp/') || f === '.env')).toBe(false);
  });
});

describe('ghk reverse accept and coverage (R-14, R-15)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('names that drifted still count as specified', () => {
    expect(similarCommands('CreateAcademicPeriod', 'CreatePeriod')).toBe(true);
    expect(similarCommands('PlaceOrder', 'CreateOrder')).toBe(true);
    expect(similarCommands('CancelOrder', 'ApproveOrder')).toBe(false);
    expect(similarCommands('SubmitSubmission', 'SubmitFile')).toBe(false);
  });

  it('Express brownfield: every operation in the code is specified by orders.feature', async () => {
    clearTsProjects();
    dir = copyFixture('golden/brownfield-express');
    const report = runCoverage(dir, await runScan(dir));
    // Until IR-05/IR-06 (3.3.0) the IR derived CancelOrder and CancelOrderThat from this feature and no PlaceOrder;
    // reverse exposed it. Now code and feature agree.
    expect(report.coverage).toMatchObject({ operations: 2, documented: 2, undocumented: 0, percent: 100 });
    expect(report.specOnly).toEqual([]);
    // --merge leaves nothing to accept.
    const scan = await runScan(dir);
    const { candidates } = runPropose(dir, scan);
    const merged = runAccept(dir, scan, candidates, { all: true, merge: true, write: false });
    expect(merged).toMatchObject({ matched: 2, drift: false, written: [] });
  });

  it('NestJS: accepts a reviewed proposal into features/discovered, without @needs-review, keeping the evidence', async () => {
    clearTsProjects();
    dir = copyFixture('reverse/nestjs-orders');
    const scan = await runScan(dir);
    const { candidates } = runPropose(dir, scan);
    expect(runCoverage(dir, scan).coverage.percent).toBe(0);

    const result = runAccept(dir, scan, candidates, { names: ['order'], write: true });
    expect(result.written).toEqual([{ file: 'features/discovered/order.feature', aggregate: 'Order', scenarios: expect.any(Number) }]);
    const text = read(dir, 'features/discovered/order.feature');
    expect(text).toMatch(/^@reverse-engineered @characterization$/m);
    expect(text).not.toContain('@needs-review');
    expect(text).toMatch(/# evidence: ev-[0-9a-f]{10} src\/orders\/orders\.controller\.ts:\d+/);
    // Accepted, the operations are now specified; a second accept does not overwrite.
    expect(runCoverage(dir, scan).coverage.percent).toBe(100);
    expect(runAccept(dir, scan, candidates, { names: ['order'], write: true }).skipped).toEqual([{ file: 'features/discovered/order.feature', reason: 'exists (use --force to overwrite)' }]);
  });

  it('--merge reports commands a feature declares and the code does not implement', async () => {
    clearTsProjects();
    dir = copyFixture('reverse/nestjs-orders');
    fs.mkdirSync(path.join(dir, 'features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'features', 'refunds.feature'), '@aggregate:Order @command:RefundOrder @command:PlaceOrder\nFeature: Order refunds\n  As a customer\n  Scenario: Refund an order\n    When the customer refunds the order\n    Then the order is refunded\n');
    const scan = await runScan(dir);
    const { candidates } = runPropose(dir, scan);
    const result = runAccept(dir, scan, candidates, { all: true, merge: true, write: false });
    expect(result.drift).toBe(true);
    expect(result.spec?.specOnly.map(s => s.command)).toEqual(['RefundOrder']);
    // PlaceOrder is specified: the accepted feature only carries what was missing.
    expect(result.spec?.operations.find(o => o.operation === 'PlaceOrder')?.status).toBe('documented');
  });

  it('the command refuses to write without --yes when nobody can confirm', async () => {
    clearTsProjects();
    dir = copyFixture('reverse/nestjs-orders');
    runPropose(dir, await runScan(dir));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(handleReverseCommand('accept', {}, ['order'])).rejects.toThrow(/--yes/);
      expect(fs.existsSync(path.join(dir, 'features'))).toBe(false);
      await expect(handleReverseCommand('accept', {}, [])).rejects.toBeInstanceOf(UsageError);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('ghk reverse command', () => {
  it('rejects a missing or unknown subcommand and an invalid --min-confidence with a usage error', async () => {
    await expect(handleReverseCommand(undefined, {})).rejects.toBeInstanceOf(UsageError);
    await expect(handleReverseCommand('harvest', {})).rejects.toBeInstanceOf(UsageError);
    await expect(handleReverseCommand('propose', { minConfidence: 'unknown' })).rejects.toBeInstanceOf(UsageError);
    await expect(handleReverseCommand('propose', { threshold: '120' })).rejects.toBeInstanceOf(UsageError);
  });
});
