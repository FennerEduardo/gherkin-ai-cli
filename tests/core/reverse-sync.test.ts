/* ==========================================================================
   `ghk reverse sync` (PLAN-3.3.0-reverse-plus RV-02, goldens G-R3, G-R4)

   An Express service gherkin-ai never generated is characterized
   (propose → accept → commit). Then the code changes the way a team changes
   it, and sync must report each change as drift (exit 7) with a patch that,
   once applied, brings the specification back in line (exit 0):
   - a route renamed, an event removed, the status written changed, an
     endpoint deleted (G-R3);
   - lines moved only: not drift;
   - an operation the review rejected is not reported as new;
   - accept, rescan, accept --merge: nothing new to accept (G-R4).
   ========================================================================== */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { REVERSE_DIR, readCandidates, runAccept, runPropose, runScan } from '../../src/core/reverse';
import { buildCandidates } from '../../src/core/reverse/candidates';
import { runSync, parseCharacterization } from '../../src/core/reverse/sync';
import { applyDecisions, readReview } from '../../src/core/reverse/review';
import { compareWithSpec } from '../../src/core/reverse/dedup';
import { writeProposal } from '../../src/core/governance/agent-changes';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';
import { handleReverseCommand } from '../../src/commands/reverse';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'golden', 'brownfield-express');
const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const commit = (dir: string, m: string) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', m); };
const ORDERS = 'src/orders.js';
const edit = (dir: string, fn: (s: string) => string) => fs.writeFileSync(path.join(dir, ORDERS), fn(fs.readFileSync(path.join(dir, ORDERS), 'utf8')));

async function scanAndCandidates(dir: string) {
  clearTsProjects();
  const scan = await runScan(dir, { write: false });
  return { scan, candidates: buildCandidates(scan.evidence).candidates };
}

async function sync(dir: string) {
  const { scan, candidates } = await scanAndCandidates(dir);
  return runSync(dir, candidates, scan.evidence, { writePatch: (f, c) => path.relative(dir, writeProposal(dir, path.join(dir, f), c)).split(path.sep).join('/') });
}

/** The service, with an event on cancel, characterized and committed. `review` decides before accept. */
async function characterized(review?: (dir: string, candidates: ReturnType<typeof readCandidates>) => void): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-sync-'));
  dirs.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'features'), { recursive: true, force: true });
  edit(dir, s => s
    .replace("import express from 'express';\n", "import express from 'express';\nimport { EventEmitter } from 'node:events';\n")
    .replace('const store = new Map();\n', 'const store = new Map();\nconst eventBus = new EventEmitter();\n')
    .replace("  order.status = 'CANCELLED';\n", "  order.status = 'CANCELLED';\n  eventBus.emit('order.cancelled', order);\n"));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, 'existing service');
  clearTsProjects();
  const scan = await runScan(dir);
  runPropose(dir, scan);
  review?.(dir, readCandidates(dir));
  const accepted = runAccept(dir, scan, readCandidates(dir)!, { all: true, write: true });
  expect(accepted.written.map(w => w.file)).toEqual(['features/discovered/order.feature']);
  commit(dir, 'characterization');
  return dir;
}

afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('reverse sync: the accepted features against the code', () => {
  it('reads the characterization the renderer wrote', async () => {
    const dir = await characterized();
    const parsed = parseCharacterization('features/discovered/order.feature', fs.readFileSync(path.join(dir, 'features/discovered/order.feature'), 'utf8'))!;
    expect(parsed.aggregate).toBe('Order');
    expect(parsed.operations.sort()).toEqual(['CancelOrder', 'PlaceOrder']);
    expect(parsed.scenarios.find(s => s.operation === 'CancelOrder' && /^Cancel/.test(s.name))!.outcomes).toContain('the "OrderCancelled" event is published');
  }, 60000);

  it('reports no drift right after accept, and writes no patch', async () => {
    const dir = await characterized();
    const report = await sync(dir);
    expect(report).toMatchObject({ features: 1, drift: false, newOperations: [], missingOperations: [], changed: [], moved: [], patches: [] });
  }, 60000);

  it('G-R3: a renamed route is a new operation and a missing one', async () => {
    const dir = await characterized();
    edit(dir, s => s.replace("'/orders/:id/cancel'", "'/orders/:id/void'"));
    const report = await sync(dir);
    expect(report.drift).toBe(true);
    expect(report.newOperations.map(n => n.operation)).toEqual(['VoidOrder']);
    expect(report.missingOperations.map(m => m.operation)).toEqual(['CancelOrder']);
  }, 60000);

  it('G-R3: a removed event and a changed status are changed behaviour', async () => {
    const dir = await characterized();
    edit(dir, s => s.replace("  eventBus.emit('order.cancelled', order);\n", '').replace("order.status = 'CANCELLED'", "order.status = 'VOIDED'"));
    const report = await sync(dir);
    expect(report.drift).toBe(true);
    const change = report.changed.find(c => c.operation === 'CancelOrder')!;
    expect(change.removed).toEqual(expect.arrayContaining(['then: the "OrderCancelled" event is published', 'then: the order status is "CANCELLED"']));
    expect(change.added).toContain('then: the order status is "VOIDED"');
    // The patch brings the specification in line: once applied, no drift.
    expect(report.patches).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'features/discovered/order.feature'), 'utf8')).toMatch(/CANCELLED/);
    git(dir, 'apply', path.join(dir, report.patches[0]));
    expect(fs.readFileSync(path.join(dir, 'features/discovered/order.feature'), 'utf8')).toMatch(/VOIDED/);
    const after = await sync(dir);
    expect(after.drift).toBe(false);
  }, 60000);

  it('G-R3: a deleted endpoint is missing', async () => {
    const dir = await characterized();
    edit(dir, s => s.replace(/orders\.post\('\/orders\/:id\/cancel'[\s\S]*?\n\}\);\n/, ''));
    const report = await sync(dir);
    expect(report.drift).toBe(true);
    expect(report.missingOperations.map(m => m.operation)).toEqual(['CancelOrder']);
  }, 60000);

  it('moved lines are reported but are not drift', async () => {
    const dir = await characterized();
    edit(dir, s => `// Orders\n// (moved down two lines)\n${s}`);
    const report = await sync(dir);
    expect(report.drift).toBe(false);
    expect(report.moved.length).toBeGreaterThan(0);
    expect(report.patches).toHaveLength(1);
  }, 60000);

  it('does not report what the review rejected as new', async () => {
    const dir = await characterized((d, candidates) => {
      const { review } = applyDecisions(readReview(d, REVERSE_DIR), candidates!, [{ decision: 'approve', selector: '@PlaceOrder' }, { decision: 'reject', selector: '@CancelOrder' }]);
      fs.writeFileSync(path.join(d, REVERSE_DIR, 'review.json'), JSON.stringify(review));
    });
    const text = fs.readFileSync(path.join(dir, 'features/discovered/order.feature'), 'utf8');
    expect(text).toMatch(/^# Not accepted in review: CancelOrder$/m);
    expect(text).not.toMatch(/@command:CancelOrder/);
    const report = await sync(dir);
    expect(report.newOperations).toEqual([]);
    expect(report.drift).toBe(false);
  }, 60000);

  it('G-R4: accept, rescan, accept --merge finds nothing new (duplicates detected: 100%)', async () => {
    const dir = await characterized();
    const { scan, candidates } = await scanAndCandidates(dir);
    const spec = compareWithSpec(dir, candidates);
    expect(spec.coverage.percent).toBe(100);
    const merged = runAccept(dir, scan, candidates, { all: true, merge: true, write: false });
    expect(merged.written).toEqual([]);
    expect(merged.drift).toBe(false);
  }, 60000);

  it('exits 7 on drift through the command, and writes nothing with --dry-run', async () => {
    const dir = await characterized();
    edit(dir, s => s.replace("'/orders/:id/cancel'", "'/orders/:id/void'"));
    const cwd = process.cwd();
    const code = process.exitCode;
    process.chdir(dir);
    try {
      await handleReverseCommand('sync', { json: true, dryRun: true }, []);
      expect(process.exitCode).toBe(7);
      expect(fs.existsSync(path.join(dir, '.ghe', 'patches'))).toBe(false);
    } finally { process.chdir(cwd); process.exitCode = code; }
  }, 60000);
});
