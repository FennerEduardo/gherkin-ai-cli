/* ==========================================================================
   The TypeScript runtime kernel on MongoDB (stack.kernelDatabase "mongodb";
   PLAN-3.3.0 X-02). The goldens express-mongo and nestjs-mongo run IT1-IT7
   against a MongoDB 8 replica set; this checks the generated sources, the
   dependencies and the developer compose file.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { generateInfra } from '../../src/generators/infra';
import { databaseMismatch, kernelDatabase } from '../../src/generators/kernel/runtime/typescript-mysql';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const configOf = (framework: string, kernelDatabase?: string) =>
  ({ ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language: 'typescript', framework, orm: 'none', database: 'mongodb', ...(kernelDatabase ? { kernelDatabase } : {}) } }) as any;
const project = (framework: string, kernelDatabase?: string) => new Map(generatePresets(parsed, configOf(framework, kernelDatabase)).map(f => [f.filename, f.content]));
const code = (files: Map<string, string>) => [...files.entries()].filter(([n]) => n.endsWith('.ts')).map(([, c]) => c).join('\n')
  .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');

describe('TypeScript kernel on MongoDB (X-02)', () => {
  it.each(['express', 'nestjs'])('%s: no SQL or pg is left; the kernel uses transactions and an atomic claim', framework => {
    const files = project(framework, 'mongodb');
    const all = code(files);
    expect(all).not.toMatch(/from 'pg'|pool\.query\(|ON CONFLICT|SKIP LOCKED|DROP SCHEMA|INSERT INTO/);
    expect(files.get('src/runtime/db.ts')).toContain('export async function inTransaction');
    expect(files.get('src/runtime/command-service.ts')).toContain('inTransaction<CommandResult>(this.pool');
    expect(files.get('src/runtime/outbox-relay.ts')).toContain('findOneAndUpdate(');
    expect(files.get('src/runtime/outbox-relay.ts')).toContain("'$$NOW'");
    expect(files.get('test/integration/runtime.int-spec.ts')).toContain("count('ghk_outbox', { aggregate_id: 'agg-1' })");
  });

  it('package.json has the mongodb driver instead of pg', () => {
    const config = configOf('express', 'mongodb');
    const pkg = JSON.parse((generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile as { content: string }).content);
    expect(pkg.dependencies.mongodb).toBeDefined();
    expect(pkg.dependencies.pg).toBeUndefined();
  });

  it('the compose file runs a single-node replica set and the URLs name it', () => {
    const { dockerComposeYaml, envExample } = generateInfra(configOf('express', 'mongodb'));
    expect(dockerComposeYaml).toContain('image: mongo:8.0');
    expect(dockerComposeYaml).toContain('"--replSet", "rs0"');
    expect(dockerComposeYaml).toContain('mongodb://mongodb:27017/payments_db?replicaSet=rs0');
    expect(envExample).toContain('mongodb://localhost:27017/payments_db?directConnection=true');
  });

  it('declaring "mongodb" without kernelDatabase keeps the PostgreSQL kernel, and generate says so (M-04)', () => {
    expect(kernelDatabase(configOf('express'))).toBe('postgresql');
    expect(code(project('express'))).toMatch(/from 'pg'/);
    expect(databaseMismatch(configOf('express'))).toMatch(/Set stack\.kernelDatabase "mongodb"/);
    // A runtime without a MongoDB kernel yet keeps PostgreSQL.
    expect(kernelDatabase({ stack: { ...defaultConfig.stack, language: 'ruby', kernelDatabase: 'mongodb' } } as any)).toBe('postgresql');
  });
});
