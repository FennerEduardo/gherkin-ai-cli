import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { lintSpecification, withoutQuotedText } from '../../src/core/specification-linter';
import { handleLintCommand } from '../../src/commands/lint';
import { resetOutputState } from '../../src/utils/output';

const FEATURE = `Feature: Course catalog
  LMS courses. Glossary: LMS = learning management system.

  Scenario: Publish a course
    Given an instructor in the LMS
    When the instructor publishes the course "MATH-101" with code "SQL-200"
    Then the course "MATH-101" appears in the catalog with format "JSON"

  Scenario: Publish another course
    Given an instructor
    When the instructor publishes the course "MATH-102"
    Then the course is visible to ABC members and ABC admins
`;

describe('lint rules', () => {
  const diags = () => lintSpecification(parseGherkinText(FEATURE), 'course.feature').diagnostics;

  it('ignores quoted values and acronyms defined in the description (GHK006)', () => {
    const ghk006 = diags().filter(d => d.ruleId === 'GHK006');
    expect(ghk006.map(d => d.message).join(' ')).not.toMatch(/MATH|SQL|JSON|LMS/);
  });

  it('reports an undefined acronym once per feature (GHK006)', () => {
    expect(diags().filter(d => d.ruleId === 'GHK006' && d.message.includes('"ABC"'))).toHaveLength(1);
  });

  it('does not flag quoted values as implementation leakage (GHK007)', () => {
    expect(diags().filter(d => d.ruleId === 'GHK007')).toEqual([]);
  });

  it('keeps apostrophes inside words', () => {
    expect(withoutQuotedText("the student's grade is 'A'")).toBe("the student's grade is ''");
  });
});

describe('ghk lint', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-lint-'));
    cwd = process.cwd();
    process.chdir(dir);
    process.exitCode = undefined;
    resetOutputState();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the feature file does not exist', async () => {
    await handleLintCommand({ feature: 'missing.feature' });
    expect(process.exitCode).toBe(4);
  });

  it('fails in JSON mode too and reports the file', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    await handleLintCommand({ feature: 'missing.feature', json: true });
    expect(process.exitCode).toBe(4);
    expect(out.join('')).toContain('GHK000');
  });
});

describe('ghk lint --all / converge --all', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-all-'));
    cwd = process.cwd();
    process.exitCode = undefined;
    resetOutputState();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const project = (rel: string, specDir: string | undefined, features: Record<string, string>) => {
      const root = path.join(dir, rel);
      fs.mkdirSync(path.join(root, specDir ?? 'features'), { recursive: true });
      fs.writeFileSync(path.join(root, 'gherkin-ai.config.json'), JSON.stringify({ projectName: rel.replace(/\W/g, ''), ...(specDir ? { specDir } : {}) }));
      for (const [name, text] of Object.entries(features)) fs.writeFileSync(path.join(root, specDir ?? 'features', name), text);
    };
    project('services/orders', undefined, { 'orders.feature': FEATURE });
    project('services/billing', 'specs/acceptance', { 'billing.feature': FEATURE.replace('Course catalog', 'Billing') });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/gherkin-ai.config.json'), '{}');
    process.chdir(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lints every feature of every project, honouring specDir and skipping node_modules', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    await handleLintCommand({ all: true, json: true, threshold: '0' });
    const rows = JSON.parse(out.join(''));
    expect(rows.map((r: any) => `${r.project}:${r.feature}`)).toEqual(['services/billing:specs/acceptance/billing.feature', 'services/orders:features/orders.feature']);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the gate when a feature is below the threshold', async () => {
    await handleLintCommand({ all: true, threshold: '101' });
    expect(process.exitCode).toBe(4);
  });

  it('converges every feature and reports drift with exit 7', async () => {
    const { handleConvergeCommand } = await import('../../src/commands/converge');
    await handleConvergeCommand({ all: true, threshold: '101' });
    expect(process.exitCode).toBe(7);
  });
});
