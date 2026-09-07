import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { buildSpecificationIR } from '../src/core/ir-builder';
import { lintSpecification } from '../src/core/specification-linter';
import { checkConvergence } from '../src/core/convergence-engine';
import { scanContextSecurity } from '../src/core/context-security';
import { telemetry } from '../src/core/telemetry';

describe('GAP Closure Core Modules', () => {
  const sampleGherkin = `
Feature: User Transfer Payment
  As a verified banking customer
  I want to transfer funds to another account
  So that I can settle debts quickly

  @security @auth @idempotent
  Scenario: Successful payment transfer
    Given the user is authenticated with "JWT_VALID"
    And the account balance is 500 USD
    When the user submits a transfer of 100 USD to account "ACC-9988"
    Then the system should deduct 100 USD from the account balance
    And the account balance must not be negative
    And the system should record a transaction audit event
    And the HTTP response status code should be 200
  `;

  it('should compile Gherkin AST into rich Specification IR', () => {
    const parsed = parseGherkinText(sampleGherkin);
    const ir = buildSpecificationIR(parsed, 'transfer.feature');

    expect(ir.featureName).toBe('User Transfer Payment');
    expect(ir.actors.length).toBeGreaterThan(0);
    expect(ir.commands.length).toBeGreaterThan(0);
    expect(ir.invariants.length).toBeGreaterThan(0);
    expect(ir.traceability.coverage.specifiedRequirements).toBeGreaterThan(0);
  });

  it('should lint Gherkin specifications and return high score for complete spec', () => {
    const parsed = parseGherkinText(sampleGherkin);
    const lintResult = lintSpecification(parsed, 'transfer.feature');

    expect(lintResult.score).toBeGreaterThanOrEqual(70);
    expect(lintResult.passed).toBe(true);
  });

  it('should evaluate convergence between specification and code', () => {
    const parsed = parseGherkinText(sampleGherkin);
    const ir = buildSpecificationIR(parsed, 'transfer.feature');
    const convergence = checkConvergence(ir, process.cwd());

    expect(convergence.overallConvergence).toBeGreaterThanOrEqual(0);
    expect(convergence.dimensions).toHaveLength(6);
  });

  it('should detect secrets and PII using Context Security Layer', () => {
    const textWithSecret = 'const key = "AKIA1234567890123456";';
    const scan = scanContextSecurity(textWithSecret);

    expect(scan.isSafe).toBe(false);
    expect(scan.secretCount).toBe(1);
    expect(scan.dataClassification).toBe('RESTRICTED');
  });

  it('should record telemetry and audit events', () => {
    telemetry.recordEvent({
      eventType: 'SPEC_LINT',
      durationMs: 42,
      qualityScore: 95,
      success: true
    });

    const summary = telemetry.getSummary();
    expect(summary.totalEvents).toBeGreaterThan(0);
  });
});
