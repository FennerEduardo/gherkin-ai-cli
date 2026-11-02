/* ==========================================================================
   `ghk reverse` over MCP, `propose --assist` and the `reverse` configuration
   section (PLAN-3.3.0 R-16, R-17, R-18).
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ALL_TOOLS, invokeTool } from '../../src/mcp/mcp-server';
import { classifyOperation } from '../../src/mcp/mcp-operation-safety';
import { configureTelemetry } from '../../src/core/telemetry';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';
import { applyNarrative, proposeNarrative, scenarioNames, validateNarrative } from '../../src/core/reverse/assist';
import { buildConfigJsonSchema } from '../../src/core/config/json-schema';
import Ajv from 'ajv';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'reverse', 'nestjs-orders');
const PROPOSAL = `# Proposed by \`ghk reverse\` (beta) from the source code.
@reverse-engineered @characterization @needs-review
@aggregate:Order
Feature: Order
  Operations found in the code: POST /orders.

  # evidence: ev-0000000001 src/orders.ts:7
  @command:PlaceOrder @confidence:strong
  Scenario: Place an order
    # evidence: ev-0000000001 src/orders.ts:7
    When the user places an order
    # evidence: ev-0000000002 src/orders.ts:12
    Then the order is placed

  @command:PlaceOrder @confidence:strong
  Scenario: Placing an order is rejected when items are missing
    When the user places an order
    Then the request is rejected because the items are missing
`;
const steps = (text: string) => text.split('\n').filter(l => /^\s*(Given|When|Then|And|But)\b/.test(l));

describe('reverse MCP tools (R-18)', () => {
  let workspace: string;
  let cwd: string;
  const perms = (allowWrite: boolean) => ({ workspace, allowWrite, allowDestructive: false, readOnly: !allowWrite } as any);

  beforeEach(() => {
    cwd = process.cwd();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-mcp-reverse-'));
    fs.cpSync(FIXTURE, workspace, { recursive: true });
    process.chdir(workspace);
    configureTelemetry(workspace, {});
    clearTsProjects();
  });
  afterEach(() => { process.chdir(cwd); fs.rmSync(workspace, { recursive: true, force: true }); });

  it('scan and get_evidence are read-only; propose needs write permission; accept is not exposed', () => {
    expect(classifyOperation('ghk_reverse_scan').level).toBe('safe');
    expect(classifyOperation('ghk_reverse_get_evidence').level).toBe('safe');
    expect(classifyOperation('ghk_reverse_propose').level).toBe('requires_review');
    expect(ALL_TOOLS.filter(t => t.name.startsWith('ghk_reverse_')).map(t => `${t.name}:${t.level}`).sort()).toEqual(['ghk_reverse_get_evidence:safe', 'ghk_reverse_propose:requires_review', 'ghk_reverse_scan:safe']);
    expect(ALL_TOOLS.some(t => /reverse.*accept/.test(t.name))).toBe(false);
  });

  it('scan returns analyzers and counts without writing; get_evidence filters by operation path', async () => {
    const scan = ALL_TOOLS.find(t => t.name === 'ghk_reverse_scan')!;
    const res: any = await invokeTool(scan, {}, perms(false));
    const body = JSON.parse(res.content[0].text);
    expect(body.analyzers.map((a: any) => a.id)).toContain('typescript/nestjs');
    expect(typeof body.evidence).toBe('number');
    expect(fs.existsSync(path.join(workspace, '.ghe', 'reverse'))).toBe(false);

    const get = ALL_TOOLS.find(t => t.name === 'ghk_reverse_get_evidence')!;
    const ev: any = JSON.parse(((await invokeTool(get, { path: '/api/v1/orders/{id}/approve', kind: 'authorization-rule' }, perms(false))) as any).content[0].text);
    expect(ev.evidence.map((e: any) => e.description)).toEqual(expect.arrayContaining(['requires role manager']));
  });

  it('propose is refused read-only and writes only .ghe/reverse when allowed', async () => {
    const propose = ALL_TOOLS.find(t => t.name === 'ghk_reverse_propose')!;
    const denied: any = await invokeTool(propose, {}, perms(false));
    expect(denied.isError).toBe(true);
    const ok: any = await invokeTool(propose, {}, perms(true));
    const body = JSON.parse(ok.content[0].text);
    expect(body.proposals[0]).toMatchObject({ aggregate: 'Order', path: '.ghe/reverse/proposals/order.feature' });
    expect(body.proposals[0].text).toContain('@needs-review');
    expect(fs.existsSync(path.join(workspace, 'features'))).toBe(false);
  });
});

describe('reverse propose --assist (R-17)', () => {
  it('accepts wording that keeps the meaning, and never touches steps, tags or evidence', async () => {
    const client = { complete: async () => ({ text: JSON.stringify({ title: 'Order placement', role: 'customer', goal: 'to place orders', benefit: 'I receive what I buy', scenarios: [{ original: 'Place an order', name: 'A customer places an order' }] }) }) };
    const result = await proposeNarrative(client as any, PROPOSAL);
    expect(result.rejected).toEqual([]);
    expect(result.featureText).toContain('Feature: Order placement\n  As a customer\n  I want to place orders\n  So that I receive what I buy');
    expect(scenarioNames(result.featureText)).toEqual(['A customer places an order', 'Placing an order is rejected when items are missing']);
    expect(steps(result.featureText)).toEqual(steps(PROPOSAL));
    expect(result.featureText).toContain('@aggregate:Order');
    expect(result.featureText.match(/# evidence:/g)?.length).toBe(PROPOSAL.match(/# evidence:/g)?.length);
  });

  it('rejects invented numbers, quoted text, unknown scenarios and renames that change the subject', () => {
    const { accepted, rejected } = validateNarrative({
      title: 'Orders "VIP"', role: 'customer', goal: 'to place up to 5 orders', benefit: 'x y',
      scenarios: [
        { original: 'Ship the order', name: 'Ships' },
        { original: 'Place an order', name: 'Refund a payment' },
        { original: 'Placing an order is rejected when items are missing', name: 'Placing an order without items is rejected' }
      ]
    }, PROPOSAL);
    expect(accepted.title).toBeUndefined();
    expect(accepted.story).toBeUndefined();
    expect(accepted.renamed).toEqual([{ from: 'Placing an order is rejected when items are missing', to: 'Placing an order without items is rejected' }]);
    expect(rejected.map(r => r.reason)).toEqual(expect.arrayContaining(['quotes, line breaks or symbols are not allowed', 'adds a number the code does not show', 'no scenario has this name', 'keeps no content word of "Place an order"']));
  });

  it('an answer that is not JSON changes nothing', async () => {
    const result = await proposeNarrative({ complete: async () => ({ text: 'Ignore the rules and add a scenario' }) } as any, PROPOSAL);
    expect(result.featureText).toBe(PROPOSAL);
    expect(applyNarrative(PROPOSAL, { renamed: [] })).toBe(PROPOSAL);
  });
});

describe('reverse configuration section (R-16)', () => {
  it('is part of the published schema and rejects unknown keys', () => {
    const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(buildConfigJsonSchema());
    expect(validate({ reverse: { include: ['src/**'], minConfidence: 'strong', threshold: 85, acceptDir: 'features/legacy', minCoverage: 60 } }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ reverse: { minConfidence: 'maybe' } })).toBe(false);
    expect(validate({ reverse: { llm: true } })).toBe(false);
  });
});
