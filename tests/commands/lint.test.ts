import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { lintSpecification, withoutQuotedText } from '../../src/core/specification-linter';
import { handleLintCommand } from '../../src/commands/lint';

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
