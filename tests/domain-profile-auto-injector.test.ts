import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { buildIR } from '../src/core/ir-builder';
import { resolveDomainProfile } from '../src/core/profiles/profile-registry';
import { generatePresets } from '../src/generators/presets';
import { generateContracts } from '../src/generators/contracts';
import { validateFinancialGates } from '../src/core/validators/financial-gates';
import { GherkinAIConfig } from '../src/core/config';

describe('Automatic Domain Profile Injector (Option 2)', () => {
  const mockGherkin = `
Feature: Online Checkout
  Scenario: Customer places order
    Given a customer with active shopping cart
    When the customer submits payment for 150 USD
    Then the order status becomes "CONFIRMED"
`;

  it('resolves PaymentProfile for payments and fintech keywords', () => {
    const profile1 = resolveDomainProfile('payments');
    const profile2 = resolveDomainProfile('fintech');
    const profile3 = resolveDomainProfile('payment-platform');

    expect(profile1).toBeDefined();
    expect(profile1?.id).toBe('payments');
    expect(profile2?.id).toBe('payments');
    expect(profile3?.id).toBe('payments');
  });

  it('automatically enriches Semantic IR when domainProfile: "payments" is specified', () => {
    const parsed = parseGherkinText(mockGherkin);
    const ir = buildIR(parsed, 'checkout.feature', { domainProfile: 'payments' });

    // Events auto-injected
    expect(ir.events.some(e => e.name === 'PaymentInitiated')).toBe(true);
    expect(ir.events.some(e => e.name === 'PaymentAuthorized')).toBe(true);
    expect(ir.events.some(e => e.name === 'PaymentCompleted')).toBe(true);
    expect(ir.events.some(e => e.name === 'PaymentFailed')).toBe(true);

    // Commands auto-injected
    expect(ir.commands.some(c => c.name === 'InitiatePayment')).toBe(true);
    expect(ir.commands.some(c => c.name === 'AuthorizePayment')).toBe(true);
    expect(ir.commands.some(c => c.name === 'CapturePayment')).toBe(true);

    // State Machine auto-injected
    expect(ir.stateMachines.some(sm => sm.entity === 'PaymentLifecycle')).toBe(true);

    // Constraints & Governance Rules auto-injected
    expect(ir.constraints.some(c => c.description.includes('pci-dss-compliance'))).toBe(true);
    expect(ir.constraints.some(c => c.description.includes('idempotency-required'))).toBe(true);
  });

  it('generates multi-stack presets enriched with PaymentProfile events and rules', () => {
    const parsed = parseGherkinText(mockGherkin);
    const config: GherkinAIConfig = {
      projectName: 'PayCore.Api',
      architecture: 'cqrs',
      stack: {
        language: 'csharp',
        framework: 'dotnet-aspnetcore',
        orm: 'efcore',
        database: 'postgresql',
        validation: 'fluentvalidation',
        auth: 'jwt',
        testing: 'xunit'
      },
      outputDir: './specs',
      domainProfile: 'payments',
      rules: {}
    };

    const files = generatePresets(parsed, config);
    expect(files.length).toBeGreaterThan(5);
    const domainFile = files.find(f => f.filename.includes('src/Domain/OnlineCheckout.cs'))!;
    expect(domainFile).toBeDefined();
    expect(domainFile.content).toContain('AggregateRoot<Guid>');
  });

  it('automatically triggers validateFinancialGates when rules include "payments"', () => {
    const valContext = {
      files: [
        {
          path: 'PaymentDto.cs',
          content: 'public class PaymentDto { public string CreditCard { get; set; } }'
        }
      ],
      rules: ['payments']
    };

    const result = validateFinancialGates(valContext);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('PCI-DSS Violation'))).toBe(true);
  });
});
