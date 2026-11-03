/* ==========================================================================
   The Go runtime kernel on MySQL (stack.kernelDatabase "mysql";
   PLAN-3.3.0 X-01b). The golden go-mysql runs IT1-IT7 against MySQL 8.4;
   this checks the generated sources and go.mod.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const project = (kernelDatabase?: string) => {
  const config = { ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language: 'go', framework: 'chi', database: 'mysql', ...(kernelDatabase ? { kernelDatabase } : {}) } } as any;
  const files = generatePresets(parsed, config);
  const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
  files.push(...(Array.isArray(root) ? root : root ? [root] : []));
  return new Map(files.map(f => [f.filename, f.content]));
};
// Code, not comments (db.go explains what it stands in for).
const text = (files: Map<string, string>) => [...files.entries()].filter(([n]) => /(\.go|go\.mod)$/.test(n)).map(([, c]) => c).join('\n')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

describe('Go kernel on MySQL (X-01b)', () => {
  it('no PostgreSQL SQL or pgx is left', () => {
    const files = project('mysql');
    const all = text(files);
    expect(all).not.toMatch(/ON CONFLICT|RETURNING id|make_interval|DROP SCHEMA|jackc\/pgx|pgxpool|pgx\.|[^.\w]now\(\)/);
    expect(all).toMatch(/INSERT IGNORE INTO/);
    expect(all).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(all).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(files.get('go.mod')).toContain('github.com/go-sql-driver/mysql v1.8.1');
    expect(files.get('internal/runtime/db.go')).toContain('func NewPool(');
    expect(files.get('internal/runtime/schema.go')).toContain("GET_LOCK('ghk_runtime_schema', 60)");
    // External tests in internal/runtime (package runtime_test) and the server use the qualified names.
    const external = [...files.entries()].filter(([n, c]) => n.endsWith('.go') && !/^package runtime$/m.test(c)).map(([, c]) => c).join('\n');
    expect(external).not.toMatch(/(?<![.\w])NewPool\(/);
  });

  it('declaring "mysql" without kernelDatabase keeps the PostgreSQL kernel (M-04)', () => {
    const all = text(project());
    expect(all).toMatch(/ON CONFLICT/);
    expect(all).toMatch(/pgxpool/);
  });
});
