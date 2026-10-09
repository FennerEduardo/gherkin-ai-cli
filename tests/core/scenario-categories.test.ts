import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR, categorizeScenarioLabels } from '../../src/core/ir-builder';

const step = (text: string) => ({ keyword: 'Then', text });

describe('scenario categories', () => {
  it('labels a denied request as both authorization and error-handling', () => {
    const labels = categorizeScenarioLabels({
      name: 'Student cannot publish a course',
      tags: [],
      steps: [step('a student without the instructor role'), step('the request is rejected with status 403')]
    } as any);
    expect(labels).toEqual(expect.arrayContaining(['authorization', 'error-handling']));
    expect(labels).not.toContain('happy-path');
  });

  it('keeps a logged-in success as a happy path', () => {
    const labels = categorizeScenarioLabels({
      name: 'Instructor publishes a course',
      tags: [],
      steps: [step('a logged-in instructor'), step('the course is published')]
    } as any);
    expect(labels).toContain('happy-path');
  });

  it('does not treat data values as status codes', () => {
    const labels = categorizeScenarioLabels({ name: 'Order', tags: [], steps: [step('the total is 403 dollars')] } as any);
    expect(labels).toEqual(['happy-path']);
  });

  it('no longer reports authorization as missing when a scenario covers it alongside an error', () => {
    const ir = buildIR(parseGherkinText(`Feature: Course publishing
  Scenario: Instructor publishes a course
    Given a logged-in instructor
    When the instructor publishes the course "MATH-101"
    Then the course is published

  Scenario: Missing title
    Given a logged-in instructor
    When the instructor publishes a course without a title
    Then the request fails with a validation error

  Scenario: Student is denied
    Given an authenticated student without permission
    When the student publishes the course "MATH-101"
    Then access denied is returned
`), 'course.feature');
    expect(ir.qualityIndicators.missingScenarioCategories).toEqual([]);
    expect(ir.qualityIndicators.scenarioCompleteness).toBe(100);
  });

  it('counts an event asserted in a Then step as traced', () => {
    const ir = buildIR(parseGherkinText(`Feature: Orders
  Scenario: Place an order
    Given a customer
    When the customer places an order
    Then an OrderPlaced event is published
`), 'orders.feature');
    for (const evt of ir.events) {
      expect(ir.traceability.links.some(l => l.to.type === 'event' && l.to.id === evt.id)).toBe(true);
    }
    expect(ir.traceability.coverage.testedRequirements).toBeGreaterThanOrEqual(ir.events.length);
  });
});
