/* ==========================================================================
   Goldens G-R1 and G-R2 (PLAN-3.3.0-reverse-plus §4): `ghk reverse` against
   what a person names, not against the generator.

   Two services written by hand in shapes that are hard for static analysis:
   - G-R1 brownfield-nestjs-cqrs: @nestjs/cqrs; controllers only dispatch
     commands, the behaviour is in @CommandHandler classes, and a reaction
     lives in an @EventsHandler;
   - G-R2 brownfield-fat-controller: Express with all the logic, validation,
     SQL and events inline in the route handlers.
   Next to each, `expected/*.feature` were written from the product's side,
   and `expected/model.json` holds the names a person gives the model
   (aggregates, commands, events, states). F1 is micro-averaged as for the
   round trip; the states the proposals write are compared too.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runScan } from '../../src/core/reverse';
import { buildCandidates, verbFromParticiple } from '../../src/core/reverse/candidates';
import { foundModel, scoreRoundTrip, scoreSet } from '../../src/core/reverse/roundtrip';
import { renderProposals } from '../../src/core/reverse/renderer';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';

const DIR = path.join(__dirname, '..', 'fixtures', 'golden');

async function score(fixture: string) {
  clearTsProjects();
  const dir = path.join(DIR, fixture);
  const human = JSON.parse(fs.readFileSync(path.join(dir, 'expected', 'model.json'), 'utf8'));
  const scan = await runScan(dir, { write: false });
  const { candidates } = buildCandidates(scan.evidence);
  const found = foundModel(candidates);
  const states = [...new Set(candidates.flatMap(c => c.scenarios.filter(s => s.category === 'happy-path').flatMap(s => s.steps.map(st => st.text.match(/status is "([^"]+)"$/)?.[1]).filter((x): x is string => Boolean(x)))))];
  return { candidates, scan, model: scoreRoundTrip(human, found), states: scoreSet(human.states, states) };
}

describe('reverse against a person (G-R1, G-R2)', () => {
  it('reads a participle back as its verb', () => {
    expect(['issued', 'placed', 'paid', 'submitted', 'registered', 'voided', 'archived', 'opened', 'shipped', 'approved'].map(verbFromParticiple))
      .toEqual(['issue', 'place', 'pay', 'submit', 'register', 'void', 'archive', 'open', 'ship', 'approve']);
  });

  it('G-R1 CQRS: follows commands into their handlers and reads the event reaction', async () => {
    const { model, states, candidates, scan } = await score('brownfield-nestjs-cqrs');
    expect(model.commands.missing).toEqual([]);
    expect(model.events.missing).toEqual([]);
    expect(model.f1).toBe(1);
    expect(states.f1).toBe(1);
    const cancel = candidates.find(c => c.operation.name === 'CancelOrder')!;
    expect(cancel.scenarios.map(s => s.name)).toEqual(expect.arrayContaining(['Cancelling the order fails when the order does not exist', 'An unauthenticated user cannot cancel the order']));
    for (const p of renderProposals(candidates, scan.evidence)) expect(p.lint.score, p.file).toBeGreaterThanOrEqual(80);
  }, 60000);

  it('G-R2 fat controller: names the act after the event it publishes, and reads failures and roles inline', async () => {
    const { model, states, candidates, scan } = await score('brownfield-fat-controller');
    expect(model.f1).toBe(1);
    expect(states.f1).toBe(1);
    const issue = candidates.find(c => c.operation.name === 'IssueInvoice')!;
    expect(issue.scenarios[0].steps.map(s => s.text)).toEqual(expect.arrayContaining(['the invoice is issued', 'the "InvoiceIssued" event is published']));
    const voids = candidates.find(c => c.operation.name === 'VoidInvoice')!;
    expect(voids.scenarios.map(s => s.name)).toEqual(expect.arrayContaining(['A user without permission cannot void the invoice']));
    for (const p of renderProposals(candidates, scan.evidence)) expect(p.lint.score, p.file).toBeGreaterThanOrEqual(80);
  }, 60000);
});
