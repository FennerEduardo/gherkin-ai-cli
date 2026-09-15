import { describe, it, expect } from 'vitest';
import { CrossServiceImpactAnalyzer } from '../../src/core/analysis/cross-service-impact';
import { buildSpecificationIR } from '../../src/core/ir-builder';
import { parseGherkinText } from '../../src/core/gherkin-parser';

describe('CrossServiceImpactAnalyzer', () => {
  const analyzer = new CrossServiceImpactAnalyzer();

  it('evaluates LOW risk for simple internal changes', () => {
    const parsed = parseGherkinText(`Feature: Simple internal feature\nScenario: Step\nGiven state\nWhen action\nThen result`);
    const ir = buildSpecificationIR(parsed, 'simple.feature');
    const result = analyzer.analyzeImpact(ir, ['src/utils/helper.ts']);

    expect(result.riskLevel).toBe('LOW');
    expect(result.requiresHumanApproval).toBe(false);
  });

  it('evaluates CRITICAL risk and requires approval for DB schema modifications', () => {
    const parsed = parseGherkinText(`Feature: User Auth\nScenario: Change password\nGiven user\nWhen pwd changed\nThen updated`);
    const ir = buildSpecificationIR(parsed, 'auth.feature');
    const result = analyzer.analyzeImpact(ir, ['prisma/schema.prisma', 'src/models/user.ts']);

    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.affectedComponents.some(c => c.type === 'DB_SCHEMA')).toBe(true);
  });

  it('evaluates HIGH risk for AsyncAPI event contracts', () => {
    const parsed = parseGherkinText(`Feature: Payment processing\nScenario: Emit payment completed event\nGiven payment processed\nWhen event emitted\nThen subscriber notified`);
    const ir = buildSpecificationIR(parsed, 'payment.feature');
    ir.contracts = [
      { type: 'EVENT', endpoint: 'payment.completed', entity: 'Payment' }
    ];
    const result = analyzer.analyzeImpact(ir, ['openapi.json']);

    expect(result.riskLevel).toBe('HIGH');
    expect(result.requiresHumanApproval).toBe(true);
  });
});
