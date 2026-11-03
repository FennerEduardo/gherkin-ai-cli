/* ==========================================================================
   `ghk reverse`: data shapes (PLAN-3.3.0-reverse-plus RV-07) and tests that
   contradict the code (RV-09).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPropose, runScan } from '../../src/core/reverse';
import { expectedStatusIn, eventsNamedIn } from '../../src/core/reverse/analyzers/tests/test-evidence';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';
import { parseGherkinText } from '../../src/core/gherkin-parser';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'reverse');

async function propose(fixture: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-rv07-'));
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  clearTsProjects();
  const scan = await runScan(dir);
  const result = runPropose(dir, scan);
  const text = (f: string) => fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'proposals', f), 'utf8');
  return { dir, scan, result, text };
}

describe('reverse: data shapes (RV-07)', () => {
  it('lists the request fields and rules under the success When, and every value comes from the code', async () => {
    const { scan, result, text, dir } = await propose('nestjs-orders');
    try {
      const place = result.candidates.find(c => c.operation.name === 'PlaceOrder')!;
      const when = place.scenarios[0].steps.find(s => s.keyword === 'When')!;
      expect(when.table![0]).toEqual(['field', 'rules']);
      const contract = scan.evidence.find(e => e.kind === 'input-contract' && when.evidence.includes(e.id))!;
      const fields = (contract.metadata as any).fields as { name: string; rules: string[] }[];
      for (const [field, rules] of when.table!.slice(1)) {
        const f = fields.find(x => x.name === field);
        expect(f, field).toBeDefined();
        for (const r of rules.split(', ').filter(x => x !== '-')) expect(f!.rules).toContain(r);
      }
      // The outline: one row per field and rule, each with its own evidence, which is a validation rule on that field.
      const outline = place.scenarios.find(s => s.examples)!;
      const byId = new Map(scan.evidence.map(e => [e.id, e]));
      for (const row of outline.examples!.rows) {
        expect(row.evidence.length).toBeGreaterThan(0);
        for (const id of row.evidence) expect(byId.get(id)!.kind).toBe('validation-rule');
      }
      // The rendered feature parses, as a Scenario Outline with its Examples.
      const parsed = parseGherkinText(text('order.feature'));
      expect(parsed.scenarios.some(s => /a field is invalid/.test(s.name))).toBe(true);
      expect(text('order.feature')).toMatch(/Scenario Outline: Placing an order is rejected when a field is invalid/);
      expect(text('order.feature')).toMatch(/\|\s*quantity\s*\|\s*not large enough\s*\|/);
      expect(result.proposals.every(p => p.lint.passed && p.roundTrip.ok)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe('reverse: tests that contradict the code (RV-09)', () => {
  it('reads the status a test expects and the events it names', () => {
    expect(expectedStatusIn("await request(app).post('/orders').expect(201)")).toBe(201);
    expect(expectedStatusIn('expect(res.status).toBe(404);')).toBe(404);
    expect(expectedStatusIn('.andExpect(status().isNotFound())')).toBe(404);
    expect(expectedStatusIn('.andExpect(status().is(409))')).toBe(409);
    expect(expectedStatusIn('assert response.status_code == 422')).toBe(422);
    expect(expectedStatusIn('Assert.Equal(HttpStatusCode.Created, response.StatusCode);')).toBe(201);
    expect(expectedStatusIn('assert.Equal(t, http.StatusOK, rec.Code)')).toBe(200);
    expect(eventsNamedIn("expect(published).toContain('order.shipped'); emit(\"OrderPlaced\")")).toEqual(['OrderPlaced', 'order.shipped']);
  });

  it('reports a different success status, a route the code lacks and an event no code publishes', async () => {
    const { dir, result } = await propose('conflicts-express');
    try {
      const kinds = result.conflicts.map(c => `${c.kind}:${c.expected}`).sort();
      expect(kinds).toEqual(['event:order.shipped', 'route:GET /orders/1/history', 'status:200']);
      expect(result.conflicts.find(c => c.kind === 'status')!.message).toMatch(/expects 200 from POST \/orders; the code returns 201/);
      // Their operations are no longer confirmed by those tests.
      const place = result.candidates.find(c => c.operation.name === 'CreateOrder' || c.operation.method === 'POST')!;
      expect(place.scenarios.every(s => s.confidence === 'inferred')).toBe(true);
      const written = JSON.parse(fs.readFileSync(path.join(dir, '.ghe', 'reverse', 'conflicts.json'), 'utf8'));
      expect(written).toHaveLength(3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
