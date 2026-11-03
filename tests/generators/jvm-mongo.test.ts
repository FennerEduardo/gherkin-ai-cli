/* ==========================================================================
   The Spring Boot (Java) runtime kernel on MongoDB (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). The golden java-mongo runs IT1-IT7 against a
   MongoDB 8 replica set; this checks the generated sources and the pom.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { kernelDatabase } from '../../src/generators/kernel/runtime/typescript-mysql';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const configOf = (language: string, framework: string, kernelDatabase?: string) =>
  ({ ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language, framework, orm: 'jdbc', database: 'mongodb', ...(kernelDatabase ? { kernelDatabase } : {}) } }) as any;
const project = (config: any) => {
  const files = generatePresets(parsed, config);
  const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
  files.push(...(Array.isArray(root) ? root : root ? [root] : []));
  return new Map(files.map(f => [f.filename, f.content]));
};
const main = (files: Map<string, string>) => [...files.entries()].filter(([n]) => n.startsWith('src/main/') && n.endsWith('.java')).map(([, c]) => c).join('\n');

describe('Spring Boot (Java) kernel on MongoDB (X-02)', () => {
  it('no JDBC, SQL, DataSource or JPA is left in the service', () => {
    const files = project(configOf('java', 'spring-boot', 'mongodb'));
    const code = main(files);
    expect(code).not.toMatch(/java\.sql\.Connection|PreparedStatement|DataSource|ON CONFLICT|SKIP LOCKED|INSERT INTO/);
    expect(code).toContain('connections.inTransaction(session -> execute(session, req, traceparent))');
    expect(code).toContain('findOneAndUpdate(pending, lease');
    const pom = files.get('pom.xml')!;
    expect(pom).toContain('<artifactId>mongodb-driver-sync</artifactId>');
    expect(pom).not.toMatch(/spring-boot-starter-data-jpa|org\.postgresql/);
    expect([...files.entries()].find(([n]) => n.endsWith('RuntimeIntegrationTest.java'))![1]).toContain('count("ghk_outbox", new Document("aggregate_id", "agg-1"))');
  });

  it('Quarkus and Kotlin keep PostgreSQL (MongoDB is Spring Boot Java only in 3.3.0)', () => {
    expect(kernelDatabase(configOf('java', 'spring-boot', 'mongodb'))).toBe('mongodb');
    expect(kernelDatabase(configOf('java', 'quarkus', 'mongodb'))).toBe('postgresql');
    expect(kernelDatabase(configOf('kotlin', 'spring-boot', 'mongodb'))).toBe('postgresql');
  });
});
