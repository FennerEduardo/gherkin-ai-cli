/* ==========================================================================
   The FastAPI runtime kernel on MongoDB (stack.kernelDatabase "mongodb";
   PLAN-3.3.0 X-02). The golden fastapi-mongo runs IT1-IT7 against a MongoDB 7.0
   replica set; this checks the generated sources.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { generatePresets } from '../../src/generators/presets';
import { kernelDatabase } from '../../src/generators/kernel/runtime/typescript-mysql';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const configOf = (framework: string, kernelDatabase?: string) =>
  ({ ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language: 'python', framework, database: 'mongodb', ...(kernelDatabase ? { kernelDatabase } : {}) } }) as any;
const project = (framework: string, kernelDatabase?: string) => new Map(generatePresets(parsed, configOf(framework, kernelDatabase)).map(f => [f.filename, f.content]));
const code = (files: Map<string, string>) => [...files.entries()].filter(([n]) => /\.(py|toml)$/.test(n)).map(([, c]) => c).join('\n')
  .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('FastAPI kernel on MongoDB (X-02)', () => {
  it('no SQL or psycopg is left; the kernel uses transactions and an atomic claim', () => {
    const files = project('fastapi', 'mongodb');
    const all = code(files);
    expect(all).not.toMatch(/psycopg|ON CONFLICT|SKIP LOCKED|DROP SCHEMA|INSERT INTO|SELECT /);
    expect(files.get('pyproject.toml')).toContain('"pymongo>=4.10",');
    expect(files.get('app/runtime/db.py')).toContain('def in_transaction(');
    expect(files.get('app/runtime/command_service.py')).toContain('return in_transaction(self.dsn,');
    expect(files.get('app/runtime/outbox_relay.py')).toContain('find_one_and_update(');
    expect(files.get('app/database.py')).toContain('DATABASE_URL = "sqlite:///./app.db"');
    expect(files.get('tests/integration/test_runtime.py')).toContain('count(schema, "ghk_outbox", {"aggregate_id": "agg-1"})');
  });

  it('Django runs the same kernel on MongoDB; its own ORM keeps SQLite', () => {
    expect(kernelDatabase(configOf('django', 'mongodb'))).toBe('mongodb');
    const files = project('django', 'mongodb');
    expect(code(files)).not.toMatch(/psycopg|ON CONFLICT|SKIP LOCKED|DROP SCHEMA|INSERT INTO|SELECT /);
    expect(files.get('app/runtime/command_service.py')).toContain('return in_transaction(self.dsn,');
    expect(files.get('config/settings.py')).toContain('django.db.backends.sqlite3');
  });
});
