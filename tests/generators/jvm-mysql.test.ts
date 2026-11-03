/* ==========================================================================
   The JVM runtime kernel on MySQL (stack.kernelDatabase "mysql";
   PLAN-3.3.0 X-01b). The goldens java-mysql, kotlin-mysql, quarkus-mysql and
   kotlin-quarkus-mysql run IT1-IT7 against MySQL 8.4; this checks the
   generated sources and build files for every JVM preset.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const configOf = (language: string, framework: string, kernelDatabase?: string) =>
  ({ ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language, framework, orm: 'jdbc', database: 'mysql', ...(kernelDatabase ? { kernelDatabase } : {}) } }) as any;
const project = (language: string, framework: string, kernelDatabase?: string) => {
  const config = configOf(language, framework, kernelDatabase);
  const files = generatePresets(parsed, config);
  const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
  files.push(...(Array.isArray(root) ? root : root ? [root] : []));
  return new Map(files.map(f => [f.filename, f.content]));
};
const all = (files: Map<string, string>) => [...files.entries()].filter(([n]) => /\.(java|kt|xml|kts|properties)$/.test(n)).map(([, c]) => c).join('\n');

describe('JVM kernel on MySQL (X-01b)', () => {
  it.each([['java', 'spring-boot'], ['kotlin', 'spring-boot'], ['java', 'quarkus'], ['kotlin', 'quarkus']])('%s / %s: no PostgreSQL SQL or driver is left', (language, framework) => {
    const files = project(language, framework, 'mysql');
    const text = all(files);
    expect(text).not.toMatch(/ON CONFLICT|RETURNING id|make_interval|DROP SCHEMA|org\.postgresql|jdbc-postgresql|db-kind=postgresql/);
    expect(text).toMatch(/INSERT IGNORE INTO/);
    expect(text).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(text).toMatch(/mysql-connector-j|quarkus-jdbc-mysql/);
    const schema = [...files.entries()].find(([n]) => n.endsWith('/Schema.java'))![1];
    expect(schema).toContain("GET_LOCK('ghk_runtime_schema', 60)");
    expect(schema).toContain('CREATE DATABASE IF NOT EXISTS');
  });

  it('declaring "mysql" without kernelDatabase keeps the PostgreSQL kernel (M-04)', () => {
    const text = all(project('java', 'spring-boot'));
    expect(text).toMatch(/ON CONFLICT/);
    expect(text).toMatch(/org\.postgresql/);
  });
});
