/* ==========================================================================
   The Python runtime kernel on MySQL (stack.kernelDatabase "mysql";
   PLAN-3.3.0 X-01b). The goldens fastapi-mysql and django-mysql run IT1-IT7
   against MySQL 8.4; this checks the generated sources.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { generatePresets } from '../../src/generators/presets';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const project = (framework: string, kernelDatabase?: string) =>
  new Map(generatePresets(parsed, { ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language: 'python', framework, database: 'mysql', ...(kernelDatabase ? { kernelDatabase } : {}) } } as any)
    .map(f => [f.filename, f.content]));
const text = (files: Map<string, string>) => [...files.entries()].filter(([n]) => /\.(py|toml)$/.test(n)).map(([, c]) => c).join('\n');

describe('Python kernel on MySQL (X-01b)', () => {
  it.each(['fastapi', 'django'])('%s: no PostgreSQL SQL or driver is left', framework => {
    const files = project(framework, 'mysql');
    const all = text(files);
    // Comments may still name RETURNING or psycopg (to say what replaced them); code may not.
    expect(all).not.toMatch(/ON CONFLICT|RETURNING id|make_interval|DROP SCHEMA|import psycopg|psycopg\.connect|postgresql\+psycopg|[^.\w]now\(\)/);
    expect(files.get('app/database.py') ?? '').not.toMatch(/postgres/);
    expect(all).toMatch(/INSERT IGNORE INTO/);
    expect(all).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(all).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(files.get('pyproject.toml')).toMatch(/"PyMySQL>=1\.1",\n {4}"cryptography>=43",/);
    expect(files.get('app/runtime/db.py')).toContain('import pymysql');
    expect(files.get('app/runtime/schema.py')).toContain("GET_LOCK('ghk_runtime_schema', 60)");
    expect(files.get('app/runtime/command_service.py')).toMatch(/^from \. import db as kernel_db$/m);
    expect(files.get('tests/integration/test_runtime.py')).toMatch(/^from app\.runtime import db as kernel_db$/m);
  });

  it('declaring "mysql" without kernelDatabase keeps the PostgreSQL kernel (M-04)', () => {
    const all = text(project('fastapi'));
    expect(all).toMatch(/ON CONFLICT/);
    expect(all).toMatch(/psycopg/);
  });
});
