/* ==========================================================================
   The Go runtime kernel on MongoDB (stack.kernelDatabase "mongodb";
   PLAN-3.3.0 X-02). The golden go-mongo runs IT1-IT7 against a MongoDB 7.0
   replica set; this checks the generated sources and go.mod.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { generatePresets } from '../../src/generators/presets';
import { generateContracts } from '../../src/generators/contracts';

const parsed = parseGherkinText('Feature: Payment processing\n  As a customer\n  Scenario: Pay\n    Given a customer\n    When the customer pays the invoice\n    Then the invoice is paid\n');
const config = { ...defaultConfig, projectName: 'payments', stack: { ...defaultConfig.stack, language: 'go', framework: 'chi', database: 'mongodb', kernelDatabase: 'mongodb' } } as any;

describe('Go kernel on MongoDB (X-02)', () => {
  it('no pgx or SQL is left; runtime.Pool runs transactions', () => {
    const files = generatePresets(parsed, config);
    const root = generateContracts(parsed, buildIR(parsed, 'f.feature'), config).projectRootFile;
    files.push(...(Array.isArray(root) ? root : root ? [root] : []));
    const byName = new Map(files.map(f => [f.filename, f.content]));
    const code = files.filter(f => /(\.go|go\.mod)$/.test(f.filename)).map(f => f.content).join('\n');
    expect(code).not.toMatch(/jackc\/pgx|pgxpool|ON CONFLICT|SKIP LOCKED|DROP SCHEMA|INSERT INTO|SELECT /);
    expect(byName.get('go.mod')).toContain('go.mongodb.org/mongo-driver/v2 v2.2.0');
    expect(byName.get('internal/runtime/db.go')).toContain('func (p *Pool) InTransaction(');
    expect(byName.get('internal/runtime/outbox_relay.go')).toContain('FindOneAndUpdate(');
    expect(byName.get('internal/runtime/runtime_integration_test.go')).toContain('e.count(t, "ghk_outbox", bson.M{"aggregate_id": "agg-1"})');
    // go vet: no unkeyed bson.E literals.
    expect(code).not.toMatch(/bson\.D\{\{"/);
  });
});
