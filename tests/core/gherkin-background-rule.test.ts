import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';

const FEATURE = `@billing
Feature: Invoicing
  Background:
    Given a customer "ACME" with an open account

  Scenario: Issue an invoice
    When the clerk issues an invoice
    Then the invoice is issued

  @refunds
  Rule: Refunds need an issued invoice
    Background:
      Given an issued invoice

    Scenario: Refund an invoice
      When the clerk refunds the invoice
      Then the invoice is refunded
`;

describe('Background and Rule', () => {
  const parsed = parseGherkinText(FEATURE);

  it('parses scenarios inside a Rule, with the Rule tags', () => {
    expect(parsed.scenarios.map(s => s.name)).toEqual(['Issue an invoice', 'Refund an invoice']);
    expect(parsed.scenarios[1].tags).toContain('@refunds');
  });

  it('keeps feature and Rule Background steps', () => {
    expect(parsed.background?.steps.map(s => s.text)).toEqual(['a customer "ACME" with an open account', 'an issued invoice']);
    expect(parsed.domainAnalysis.fixtures).toContain('a customer "ACME" with an open account');
  });

  it('gives Background steps a step definition and runs them first in each scenario', () => {
    const model = buildDomainModel(parsed);
    expect(model.steps.some(s => s.text === 'a customer "ACME" with an open account')).toBe(true);
    for (const sc of model.scenarios) expect(sc.steps[0].text).toBe('a customer "ACME" with an open account');
  });
});
