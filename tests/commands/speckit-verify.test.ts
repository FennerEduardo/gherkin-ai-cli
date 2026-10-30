/* ==========================================================================
   ghk speckit verify (PLAN-3.2.2 X-05)

   The fixture is a Spec Kit project as `specify init` lays it out: one
   feature folder with spec.md (2 user stories, 3 acceptance scenarios,
   FR-001..003), plan.md and tasks.md (T020 of US2 is done), and an
   AGENTS.md that never mentions gherkin-ai.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleSpeckitCommand } from '../../src/commands/speckit';
import { parseSpecKitSpec, parseSpecKitTasks, verifySpecKitFeature } from '../../src/core/interop/speckit';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { resetOutputState } from '../../src/utils/output';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'speckit', 'photo-albums');

describe('ghk speckit verify', () => {
  const cwd = process.cwd();
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-speckit-verify-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    process.chdir(dir);
    out = [];
    resetOutputState();
    vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const report = async () => {
    resetOutputState();
    out.length = 0;
    await handleSpeckitCommand('verify', { json: true });
    return JSON.parse(out.join(''));
  };

  it('a spec that was never imported is drift', async () => {
    const r = await report();
    expect(r.specs[0]).toMatchObject({ spec: 'specs/001-photo-albums', feature: null, drift: true });
    expect(r.specs[0].findings.map((f: any) => f.kind)).toContain('not-imported');
    expect(process.exitCode).toBe(7);
  });

  it('after import every story, requirement and completed task is covered', async () => {
    await handleSpeckitCommand('import', {});
    const r = await report();
    const kinds = r.specs[0].findings.filter((f: any) => f.drift).map((f: any) => f.kind);
    expect(kinds).toEqual([]);
    expect(r.specs[0]).toMatchObject({ feature: 'features/photo-albums.feature', stories: 2, requirements: 3, tasks: { total: 4, done: 3 } });
    expect(typeof r.specs[0].convergence).toBe('number');
  });

  it('reports a story whose scenario was removed from the feature, and the completed task it leaves unverified', async () => {
    await handleSpeckitCommand('import', {});
    const file = path.join(dir, 'features', 'photo-albums.feature');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.slice(0, text.indexOf('  @US2')));
    const findings = (await report()).specs[0].findings;
    expect(findings.map((f: any) => f.kind)).toEqual(expect.arrayContaining(['scenario-missing', 'task-unverified']));
    expect(findings.find((f: any) => f.kind === 'task-unverified').message).toContain('T020');
    expect(process.exitCode).toBe(7);
  });

  it('flags agent instructions that never send the agent through the gates', async () => {
    const r = await report();
    expect(r.agentInstructions).toEqual({ files: ['AGENTS.md'], withoutGates: ['AGENTS.md'] });
    fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\nBefore a pull request, run `ghk lint` and `ghk converge`.\n');
    expect((await report()).agentInstructions.withoutGates).toEqual([]);
  });
});

describe('Spec Kit parsing for verify', () => {
  it('reads task status and story', () => {
    expect(parseSpecKitTasks('- [x] T010 [P] [US1] Create the model\n- [ ] T011 Setup\n* [X] T012 [US2] Share')).toEqual([
      { id: 'T010', done: true, story: 'US1', text: 'Create the model' },
      { id: 'T011', done: false, text: 'Setup' },
      { id: 'T012', done: true, story: 'US2', text: 'Share' }
    ]);
  });

  it('a requirement missing from the feature is drift', () => {
    const spec = parseSpecKitSpec('# Feature Specification: X\n\n## Requirements\n\n- **FR-001**: System MUST do it\n');
    const feature = parseGherkinText('Feature: X\n  Scenario: S\n    When it runs\n    Then it is done\n');
    expect(verifySpecKitFeature(spec, feature, [])).toEqual([expect.objectContaining({ kind: 'requirement-missing', drift: true })]);
  });
});
