/* ==========================================================================
   `ghk reverse`: the domain glossary (PLAN-3.3.0-reverse-plus RV-10) and
   line coverage as evidence (RV-15).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCoverage, runPropose, runScan } from '../../src/core/reverse';
import { featureGlossaryTerms, knownTerm, loadGlossary, parseGlossary } from '../../src/core/reverse/glossary';
import { similarCommands } from '../../src/core/reverse/dedup';
import { executedLines, parseCobertura, parseJacoco, parseLcov } from '../../src/core/reverse/coverage-lines';
import { proposeNarrative } from '../../src/core/reverse/assist';
import { lintSpecification } from '../../src/core/specification-linter';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
function copy(rel: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-rv10-'));
  fs.cpSync(path.join(FIXTURES, rel), dir, { recursive: true });
  return dir;
}

describe('reverse: the domain glossary (RV-10)', () => {
  it('reads YAML, JSON and Markdown glossaries, and Glossary: lines of features', () => {
    const y = parseGlossary('terms:\n  - term: Customer\n    synonyms: [Client, Account]\n  - Order\n', 'docs/glossary.yaml');
    expect(y.terms).toEqual(['Customer', 'Order']);
    expect(y.synonyms.get('client')).toBe('customer');
    expect(parseGlossary('{"Customer": ["Buyer"]}', 'g.json').synonyms.get('buyer')).toBe('customer');
    const md = parseGlossary('# Glossary\n\n- **Data controller** (also: controller): who decides why personal data is processed\n- Enrollment — a student in a course\nCourse: what is taught\n', 'GLOSSARY.md');
    expect(md.terms).toEqual(['Data controller', 'Enrollment', 'Course']);
    expect(md.synonyms.get('controller')).toBe('data controller');
    expect(featureGlossaryTerms(['Feature: X\n  Glossary: controller terms, SLA\n'])).toEqual(['SLA', 'controller terms']);
    expect(knownTerm(md, 'Enrollments')).toBe(true);
    expect(knownTerm(md, 'DataController')).toBe(true);
    expect(knownTerm(md, 'Invoice')).toBe(false);
  });

  it('lint reads a glossary term as business vocabulary, never a single code word', () => {
    const feature = parseGherkinText('Feature: Workspace\n  Scenario: Accept the controller terms\n    Given an institution\n    When the user accepts the controller terms\n    Then the controller terms are accepted\n');
    const leaks = (glossary?: string[]) => lintSpecification(feature, 'x.feature', { glossary }).diagnostics.filter(d => d.ruleId === 'GHK007').length;
    expect(leaks()).toBeGreaterThan(0);
    expect(leaks(['controller terms'])).toBe(0);
    expect(leaks(['controller'])).toBeGreaterThan(0);
  });

  it('a synonym in the glossary makes a renamed command, and an aggregate outside it is an open question', async () => {
    const dir = copy('golden/brownfield-express');
    try {
      expect(similarCommands('PlaceOrder', 'PlacePurchase')).toBe(false);
      fs.writeFileSync(path.join(dir, 'glossary.yaml'), 'terms:\n  - term: Purchase\n    synonyms: [Order]\n');
      fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ reverse: { glossary: 'glossary.yaml' } }));
      expect(similarCommands('PlaceOrder', 'PlacePurchase', loadGlossary(dir))).toBe(true);
      // The feature calls the order a purchase: with the glossary it is renamed, not undocumented.
      fs.writeFileSync(path.join(dir, 'features', 'orders.feature'), '@aggregate:Purchase\nFeature: Purchases\n\n  @command:PlacePurchase\n  Scenario: Place a purchase\n    When the customer places a purchase\n    Then the purchase is placed\n');
      clearTsProjects();
      const scan = await runScan(dir, { write: false });
      const place = runCoverage(dir, scan).operations.find(o => o.operation === 'PlaceOrder')!;
      expect(place.status).toBe('renamed');
      const proposed = runPropose(dir, scan, { write: false });
      expect(proposed.unresolved.some(u => /Order is not a term of the glossary \(glossary\.yaml\)/.test(u.question))).toBe(false);
      fs.writeFileSync(path.join(dir, 'glossary.yaml'), 'terms:\n  - Invoice\n');
      expect(runPropose(dir, scan, { write: false }).unresolved.some(u => /Order is not a term of the glossary \(glossary\.yaml\)/.test(u.question))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  it('--assist is told the glossary terms', async () => {
    let system = '';
    const client = { complete: async (req: { system: string }) => { system = req.system; return { text: '{}' } as any; } };
    await proposeNarrative(client as any, 'Feature: Order\n  Scenario: Place an order\n    When the user places an order\n    Then the order is placed\n', ['Purchase', 'Customer']);
    expect(system).toMatch(/Use these domain terms, as written, instead of synonyms: Purchase, Customer\./);
  });
});

describe('reverse: line coverage as evidence (RV-15)', () => {
  it('reads lcov, JaCoCo and Cobertura, and matches files by their longest common suffix', () => {
    expect([...parseLcov('TN:\nSF:/repo/src/a.ts\nDA:3,1\nDA:4,0\nend_of_record\n').get('/repo/src/a.ts')!]).toEqual([3]);
    const j = parseJacoco('<report><package name="com/shop"><sourcefile name="OrderService.java"><line nr="12" mi="0" ci="3"/><line nr="13" mi="2" ci="0"/></sourcefile></package></report>');
    expect([...j.get('com/shop/OrderService.java')!]).toEqual([12]);
    expect(executedLines(j, 'src/main/java/com/shop/OrderService.java')).toBeDefined();
    const c = parseCobertura('<coverage><packages><package><classes><class name="x" filename="app/services.py"><lines><line number="7" hits="2"/><line number="8" hits="0"/></lines></class></classes></package></packages></coverage>');
    expect([...c.get('app/services.py')!]).toEqual([7]);
  });

  it('confirms the evidence of a tested endpoint whose line ran, and nothing else', async () => {
    const dir = copy('reverse/nestjs-orders');
    try {
      // The e2e test calls POST /api/v1/orders. Lines 14 (PlaceOrder's PENDING) and 22 (ApproveOrder's not found) ran.
      fs.writeFileSync(path.join(dir, 'lcov.info'), 'TN:\nSF:src/orders/orders.service.ts\nDA:14,1\nDA:22,1\nend_of_record\n');
      clearTsProjects();
      const plain = await runScan(dir, { write: false });
      clearTsProjects();
      const covered = await runScan(dir, { write: false, coverage: ['lcov.info'] });
      // Line 14 holds two facts of PlaceOrder: the PENDING status it creates the order with, and the Prisma write.
      expect(covered.coverage).toEqual({ reports: [{ file: 'lcov.info', format: 'lcov', files: 1 }], confirmed: 2 });
      const pending = covered.evidence.find(e => e.kind === 'state-value' && e.location.startLine === 14)!;
      expect(pending.confidence).toBe('confirmed');
      expect((pending.metadata as any).executed).toBe(true);
      // ApproveOrder is not called by any test: its line ran, but that proves nothing about its outcome.
      const approveNotFound = covered.evidence.find(e => e.kind === 'error-condition' && e.location.startLine <= 22 && e.location.endLine >= 22)!;
      expect(approveNotFound.confidence).not.toBe('confirmed');
      // Without the report the scan is unchanged.
      expect(plain.coverage).toBeUndefined();
      expect(JSON.stringify(plain.evidence.map(e => e.confidence))).not.toEqual(JSON.stringify(covered.evidence.map(e => e.confidence)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
