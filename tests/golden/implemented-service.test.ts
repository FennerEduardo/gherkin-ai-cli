/* ==========================================================================
   Golden: regenerating and upgrading an implemented service

   The fixture is the LMS assessment-service as it was before its 3.2 pilot:
   a Spring Boot service marked .ghk-implemented, built on the 3.0 runtime
   kernel (edited), with its own aggregate, step definitions and
   application.yml, and the inventory of the generation that produced it.
   ghk 3.2.0 created 32 files there and left a tree that did not compile
   (LMS evidence report, E-06, E-07, #20). This golden keeps it from coming back.

   GHK_GOLDEN_MAVEN=1 also compiles the upgraded service with Maven (offline:
   needs the dependencies in ~/.m2).
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGenerateCommand } from '../../src/commands/generate';
import { handleUpgradeCommand } from '../../src/commands/upgrade';
import { resetRunContext } from '../../src/core/run-context';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'golden', 'implemented-spring-service');
const FEATURE = 'features/grade_publication.feature';
const SOURCE = /\.(java|kt)$/;

/** Every file under root (but .git and .ghe) with its sha256, by posix path. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.ghe') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return files;
}

const sources = (snap: Map<string, string>) => new Map([...snap].filter(([f]) => SOURCE.test(f)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

describe('golden: implemented Spring service (LMS assessment-service before 3.2)', () => {
  const cwd = process.cwd();
  const env = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-golden-implemented-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.ghe'));
    fs.renameSync(path.join(dir, 'inventory.fixture.json'), path.join(dir, '.ghe', 'inventory.json'));
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'golden', GIT_AUTHOR_EMAIL: 'golden@example.com', GIT_COMMITTER_NAME: 'golden', GIT_COMMITTER_EMAIL: 'golden@example.com' });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'implemented service');
    process.chdir(dir);
    resetRunContext();
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    process.env = { ...env };
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('plans no scaffolding, no second DataSource and holds the kernel until it is merged (E-06, #20, E-07, E-13)', async () => {
    const before = snapshot(dir);
    const result = await handleGenerateCommand({ feature: FEATURE, yes: true, dryRun: true });
    expect(snapshot(dir)).toEqual(before);

    const plan = result!.plan;
    const created = plan.filter(p => p.action === 'create');
    expect(created.filter(p => p.role !== 'contract' && p.role !== 'kernel'), 'only kernel and contract files may be created').toEqual([]);
    // The kernel kept as edited holds every new or updated source file back as .ghk-new.
    expect(created.filter(p => SOURCE.test(p.file))).toEqual([]);
    expect(plan.filter(p => SOURCE.test(p.file) && (p.action === 'update' || p.action === 'overwrite'))).toEqual([]);
    expect(result!.kernelPendingMerge.length).toBeGreaterThan(0);

    const skipped = plan.filter(p => p.action === 'skipped').map(p => path.posix.basename(p.file));
    for (const name of ['RuntimeConfiguration.java', 'HealthController.java', 'JwtTenantFilter.java', 'application.properties', 'GradeSteps.java']) {
      expect(skipped, name).toContain(name);
    }
    expect(result!.summary.create).toBe(created.length);
  });

  it('names no DTOs or columns after the words of the steps (#10)', async () => {
    const result = await handleGenerateCommand({ feature: FEATURE, yes: true, dryRun: true });
    // 3.2.0 planned BecauseDTO, ReasonDTO, TeacherDTO... from `because "..."`, `reason "..."`, `the teacher "t-7"`.
    expect(result!.plan.map(p => p.file).filter(f => /DTO\.java$/.test(f))).toEqual([]);

    await handleGenerateCommand({ feature: FEATURE, yes: true });
    const seed = fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8');
    expect(seed).toMatch(/INSERT INTO \w+ \(id\)/);
  });

  it('generate leaves the sources as they were and a second run changes nothing', async () => {
    const before = snapshot(dir);
    await handleGenerateCommand({ feature: FEATURE, yes: true });
    const first = snapshot(dir);

    expect(sources(first), 'no source file is added or changed').toEqual(sources(before));
    const added = [...first.keys()].filter(f => !before.has(f));
    expect(added.filter(f => /RuntimeConfiguration/.test(f)), 'no second DataSource, not even as .ghk-new').toEqual([]);
    expect(added.filter(f => f.endsWith('application.properties'))).toEqual([]);

    await handleGenerateCommand({ feature: FEATURE, yes: true });
    expect(snapshot(dir)).toEqual(first);
  });

  it('upgrade --apply --json prints the upgrade report, not the plan of the generate it runs', async () => {
    const { setRunContext } = await import('../../src/core/run-context');
    const { resetOutputState } = await import('../../src/utils/output');
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out += String(chunk); return true; });
    setRunContext({ json: true, nonInteractive: true });
    resetOutputState();
    await handleUpgradeCommand({ apply: true, yes: true, branch: 'ghk-upgrade-json', json: true });
    const report = JSON.parse(out);
    expect(report).toHaveProperty('applied.regenerated');
    expect(report.findings.map((f: any) => f.id)).toContain('kernel.pending-merge');
  });

  it('upgrade --apply commits no source change and reports the kernel merge', async () => {
    const report = await handleUpgradeCommand({ apply: true, commit: true, yes: true, branch: 'ghk-upgrade' });

    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ghk-upgrade');
    const changed = git(dir, 'diff', '--name-status', 'main', 'HEAD').split('\n').filter(Boolean);
    expect(changed.filter(l => SOURCE.test(l)), 'no .java added, changed or deleted').toEqual([]);
    expect(report.findings.map(f => f.id)).toContain('kernel.pending-merge');
  });

  // LMS mutation protocol (evidence report F2.10): lint, validate and converge caught 0 of 7; converge scored 62
  // for every mutation. M5 and M6 are the two a specification tool can see (E-11).
  describe('contract drift (E-11)', () => {
    const converge = async (opts: Record<string, unknown> = {}) => {
      const { calculateConvergence } = await import('../../src/core/convergence-engine');
      const { parseGherkinText } = await import('../../src/core/gherkin-parser');
      return calculateConvergence(parseGherkinText(fs.readFileSync(path.join(dir, FEATURE), 'utf8')), FEATURE, dir, opts);
    };

    it('M0: no drift right after generating', async () => {
      await handleGenerateCommand({ feature: FEATURE, yes: true });
      const report = await converge();
      expect(report.contractChecks?.find(c => c.check === 'spec-changed')).toMatchObject({ passed: true });
      expect(report.contractDrift).toBe(false);
    });

    it('M5: a state renamed in the feature only ("DRAFT" → "RECORDED") is drift', async () => {
      await handleGenerateCommand({ feature: FEATURE, yes: true });
      const file = path.join(dir, FEATURE);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"DRAFT"/g, '"RECORDED"'));
      const report = await converge();
      expect(report.contractDrift).toBe(true);
      expect(report.contractChecks?.find(c => c.check === 'spec-changed')).toMatchObject({ passed: false, gating: true });
      expect(report.contractChecks?.find(c => c.check === 'spec-states')?.findings.join(' ')).toContain('"RECORDED"');
    });

    it('M6: a route the service no longer serves (/grade/publication → /grade/publish) is drift with --live', async () => {
      const openapi = JSON.parse(fs.readFileSync(path.join(dir, 'openapi.json'), 'utf8'));
      const served = JSON.parse(JSON.stringify(openapi).replace(/\/grade\/publication/g, '/grade/publish'));
      const report = await converge({ live: served });
      const live = report.contractChecks?.find(c => c.check === 'live-contract');
      expect(live).toMatchObject({ passed: false, gating: true });
      expect(live!.findings.join(' ')).toMatch(/POST \/api\/v1\/institutions\/\{\}\/submissions\/\{\}\/grade\/publication/);
      expect(report.contractDrift).toBe(true);
      expect((await converge({ live: openapi })).contractChecks?.find(c => c.check === 'live-contract')?.passed).toBe(true);
    });
  });

  it.skipIf(process.env.GHK_GOLDEN_MAVEN !== '1')('the upgraded service still compiles (mvn -o test-compile)', async () => {
    await handleUpgradeCommand({ apply: true, commit: true, yes: true, branch: 'ghk-upgrade' });
    try {
      execFileSync('mvn', ['-B', '-o', '-q', 'test-compile'], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    } catch (e: any) {
      throw new Error(`mvn test-compile failed:\n${String(e.stdout ?? '').split('\n').filter(l => /ERROR/.test(l)).slice(0, 15).join('\n')}`);
    }
  }, 320_000);
});
