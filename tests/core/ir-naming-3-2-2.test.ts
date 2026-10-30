/* ==========================================================================
   Semantic model naming (PLAN-3.2.2 §3.B)

   IR-01: business verbs outside the core list ("places", "grants", "revokes")
          named commands `unknown_<words>`, and the generator fell back to
          Process<Feature>. They are now recognized, but only where the verb
          would otherwise be unknown: a feature that already produces commands
          gains none.
   IR-02: a received event was published in the consumer's asyncapi.json, and
          quoted example data ("S-1") became an event channel.
   IR-03: scenario categories depended on the word form ("validates").
   IR-04: the graph ignored domain names shorter than 6 characters ("Grade").
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import { generateContracts } from '../../src/generators/contracts';
import { categorizeScenarioLabels } from '../../src/core/ir/scenarios';
import { symbolVariants } from '../../src/core/graph/repository-graph';
import { defaultConfig } from '../../src/core/config';

const feature = (name: string, ...scenarios: string[][]) =>
  parseGherkinText(`Feature: ${name}\n${scenarios.map((steps, i) => `  Scenario: S${i + 1}\n${steps.map(s => `    ${s}`).join('\n')}\n`).join('\n')}`);

const commandOf = (step: string, featureName = 'Probe') => buildIR(feature(featureName, [`When ${step}`, 'Then it is done']), 'probe.feature').commands.map(c => c.name);

describe('IR-01: business verbs outside the core list', () => {
  // When steps from the LMS and the reference projects that 3.2.1 named unknown_*.
  const table: [string, string][] = [
    ['the customer places an order for 2 items', 'place_order'],
    ['the administrator grants "parent-55" access to the "GRADES" of "student-123"', 'grant_access'],
    ['the administrator revokes the access of "parent-55" to "student-123"', 'revoke_access'],
    ['the representative revokes consent for "req-7701"', 'revoke_consent'],
    ['the representative grants consent with recorded minor opinion for "req-7701"', 'grant_consent'],
    ['the student requests enrollment in "MATH-101"', 'request_enrollment'],
    ['"student-123" requests their grades', 'request_grades'],
    ['the caller requests a passkey enrollment code for student "sofia@school.edu"', 'request_passkey_enrollment'],
    ['the enrollment saga reserves a seat in "MATH-101-A"', 'reserve_seat'],
    ['the guardian opens the dashboard of "student-123"', 'open_dashboard'],
    ['the leader opens the academic period "2027-1"', 'open_academic_period'],
    ['"camilo@student.edu" starts the passkey enrollment with the code "K7M3Q9TX"', 'start_passkey_enrollment'],
    ['the user confirms the activation link', 'confirm_activation_link'],
    ['the student submits the file of "student-456" for "asg-1"', 'submit_file'],
    ['the administrator revokes the link for "parent@fam.co" with student "sofia@school.edu"', 'revoke_link'],
    ['I place an order', 'place_order'],
    // The object was example data: the command takes the feature's name.
    ['the student submits "asg-1"', 'submit_probe'],
    ['the administrator invites "luis@example.co" as "STUDENT" born on "2001-05-10"', 'invite_probe'],
    ['the teacher grades "sub-1" with score 87 out of 100', 'grade_probe'],
  ];

  it.each(table)('"%s" -> %s', (step, expected) => {
    expect(commandOf(step)).toEqual([expected]);
  });

  it('marks those commands as coming from the extended list', () => {
    const [command] = buildIR(feature('Probe', ['When the customer places an order', 'Then it is done']), 'probe.feature').commands;
    expect(command.verbSource).toBe('extended');
  });

  it('does not read a noun as the verb ("the request", "a review")', () => {
    expect(commandOf('the request is reviewed by nobody')).toEqual(['unknown_request_is']);
  });

  it('core verbs keep their 3.2.1 names', () => {
    expect(commandOf('the customer cancels an order that does not exist')).toEqual(['cancel_order_that']);
    expect(commandOf('the customer creates an order')).toEqual(['create_order']);
  });

  it('replaces the generator default, but adds no command to a feature that had one', () => {
    const only = buildDomainModel(feature('Orders', ['When the customer places an order', 'Then the order is "PENDING"']));
    expect(only.commands.map(c => c.name)).toEqual(['PlaceOrder']);

    const mixed = buildDomainModel(feature('Orders',
      ['When the customer places an order', 'Then the order is "PENDING"'],
      ['When the customer cancels the order', 'Then the order is "CANCELLED"']));
    expect(mixed.commands.map(c => c.name)).toEqual(['CancelOrder']);
  });
});

describe('IR-02: received events and example data', () => {
  const grading = feature('Grade publication',
    ['Given the "SubmissionGraded" event was received for student "S-1"', 'When the teacher publishes the grade for student "S-1"', 'Then the "GradePublished" event is emitted']);

  it('keeps received events out of the published ones', () => {
    const ir = buildIR(grading, 'grade_publication.feature');
    expect(ir.events.map(e => e.name)).toEqual(['GradePublished']);
    expect(ir.consumedEvents?.map(e => e.name)).toEqual(['SubmissionGraded']);
  });

  it('never makes an event of quoted example data', () => {
    const ir = buildIR(grading, 'grade_publication.feature');
    expect([...ir.events, ...(ir.consumedEvents ?? [])].map(e => e.name)).not.toContain('S1');
  });

  it('asyncapi.json publishes only its own events and lists the received ones', () => {
    const ir = buildIR(grading, 'grade_publication.feature');
    const asyncapi = JSON.parse(generateContracts(grading, ir, defaultConfig).asyncApiJson);
    expect(Object.keys(asyncapi.channels)).toEqual(['gradepublication/events/gradepublished']);
    expect(asyncapi.info['x-ghk-consumes']).toEqual(['SubmissionGraded']);
  });

  it('the kernel records no received event', () => {
    const model = buildDomainModel(grading);
    expect(model.events).not.toContain('SubmissionGraded');
  });

  it('a Background only contributes received events', () => {
    const parsed = parseGherkinText([
      'Feature: Notifications',
      '  Background:',
      '    Given the "StudentEnrolled" event was received',
      '  Scenario: Welcome',
      '    When the system sends the welcome message',
      '    Then the "WelcomeSent" event is published',
      ''
    ].join('\n'));
    const ir = buildIR(parsed, 'notifications.feature');
    expect(ir.events.map(e => e.name)).toEqual(['WelcomeSent']);
    expect(ir.consumedEvents?.map(e => e.name)).toEqual(['StudentEnrolled']);
  });
});

describe('IR-03: scenario categories by word stem', () => {
  const labels = (name: string, ...steps: string[]) => categorizeScenarioLabels({ name, tags: [], steps: steps.map(text => ({ keyword: 'Then', text })) as any });

  it.each([
    ['Portal validates the grade range', 'validation'],
    ['The request is validated', 'validation'],
    ['Only authorized teachers publish grades', 'authorization'],
    ['The gateway authorizes the call', 'authorization'],
    ['A visitor who is not signed in is denied as unauthorized', 'authorization'],
    ['The portal forbids the change', 'authorization'],
  ])('"%s" covers %s', (name, category) => {
    expect(labels(name, 'the result is recorded')).toContain(category);
  });
});

describe('IR-04: short domain names in the graph', () => {
  it('matches the PascalCase type of a short name only', () => {
    expect(symbolVariants('Grade')).toEqual(['Grade']);
    expect(symbolVariants('Order')).toEqual(['Order']);
    expect(symbolVariants('Id')).toEqual([]);
  });

  it('keeps every variant of 6 characters or more', () => {
    expect(symbolVariants('PlaceOrder')).toEqual(expect.arrayContaining(['PlaceOrder', 'placeOrder', 'place_order', 'place-order', 'PLACE_ORDER']));
  });
});
