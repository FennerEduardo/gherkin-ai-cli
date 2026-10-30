/* ==========================================================================
   The TypeScript runtime kernel on MySQL (PLAN-3.2.2 X-01, TypeScript only)
   The goldens nestjs-mysql and express-mysql run IT1-IT7 against MySQL 8.4.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';
import { buildIR } from '../../src/core/ir-builder';

const FEATURE = parseGherkinText('Feature: Payment\n  Scenario: Pay\n    When the customer pays the invoice\n    Then the payment is recorded\n');
const config = (framework: string, database: string, extra: Partial<GherkinAIConfig['stack']> = {}): GherkinAIConfig => ({
  ...defaultConfig, projectName: 'shop', outputDir: './',
  stack: { ...defaultConfig.stack, language: 'typescript', framework, orm: 'none', database, messaging: 'rabbitmq', ...extra }
});
const file = (files: { filename: string; content: string }[], name: string) => files.find(f => f.filename === name)!.content;

describe('TypeScript runtime kernel on MySQL', () => {
  const files = generatePresets(FEATURE, config('express', 'mysql'));
  const all = files.filter(f => f.filename.endsWith('.ts')).map(f => f.content).join('\n');

  it('replaces node-postgres with the mysql2 adapter everywhere', () => {
    expect(all).not.toContain("from 'pg'");
    expect(file(files, 'src/runtime/db.ts')).toContain("import mysql from 'mysql2/promise'");
    expect(file(files, 'src/runtime/command-service.ts')).toContain("from './db'");
    expect(file(files, 'src/server.ts')).toContain("from './runtime/db'");
  });

  it('uses MySQL statements: no ON CONFLICT, no RETURNING, the key column quoted', () => {
    expect(all).not.toMatch(/ON CONFLICT|RETURNING|::int|DROP SCHEMA|make_interval|EXCLUDED\./);
    expect(file(files, 'src/runtime/command-service.ts')).toContain('INSERT IGNORE INTO ${this.s}.ghk_idempotency (tenant_id, \\`key\\`, status)');
    expect(file(files, 'src/runtime/command-service.ts')).toContain('ON DUPLICATE KEY UPDATE state = incoming.state');
    const relay = file(files, 'src/runtime/outbox-relay.ts');
    expect(relay).toContain('const rows = await this.claim(workerId, limit);');
    expect(relay).toContain('FOR UPDATE SKIP LOCKED');
    // Placeholders of the claimed ids keep their "$" ($3, $4, ...).
    expect(relay).toContain('due.map((_, i) => `$${i + from}`)');
  });

  it('migrates with MySQL DDL under a named lock, in the database of DATABASE_URL by default', () => {
    const schema = file(files, 'src/runtime/schema.ts');
    expect(schema).toContain("GET_LOCK('ghk_runtime_schema', 60)");
    expect(schema).toContain('DATETIME(6)');
    expect(schema).not.toMatch(/TIMESTAMPTZ|pg_advisory/);
    expect(file(files, 'src/runtime/command-service.ts')).toContain('schema = defaultSchema()');
  });

  it('NestJS 12 keeps the .js import specifiers', () => {
    const nest = generatePresets(FEATURE, config('nestjs', 'mysql', { frameworkVersion: '12', orm: 'prisma' }));
    expect(file(nest, 'src/runtime/command-service.ts')).toContain("from './db.js'");
  });

  it('package.json depends on mysql2 instead of pg', () => {
    const cfg = config('express', 'mysql');
    const pkg = JSON.parse((generateContracts(FEATURE, buildIR(FEATURE, 'payment.feature'), cfg).projectRootFile as { content: string }).content);
    expect(pkg.dependencies).toHaveProperty('mysql2');
    expect(pkg.dependencies).not.toHaveProperty('pg');
    expect(pkg.devDependencies).not.toHaveProperty('@types/pg');
  });

  it('PostgreSQL projects are unchanged', () => {
    const pg = generatePresets(FEATURE, config('express', 'postgresql'));
    expect(pg.some(f => f.filename === 'src/runtime/db.ts')).toBe(false);
    expect(file(pg, 'src/runtime/command-service.ts')).toContain('ON CONFLICT DO NOTHING');
  });
});
