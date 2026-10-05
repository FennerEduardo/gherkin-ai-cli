import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { defaultConfig } from '../../src/core/config';
import { generateGoContracts } from '../../src/generators/contracts-go';

const config = { ...defaultConfig, projectName: 'Demo', stack: { ...defaultConfig.stack, language: 'go' } };
const contractsFor = (feature: string) => {
  const parsed = parseGherkinText(feature);
  const ir = buildIR(parsed, 'f.feature');
  return { ir, go: generateGoContracts(parsed, ir, config) };
};

describe('Go contracts', () => {
  it('omits the uuid import when the feature declares no domain events (go vet rejects unused imports)', () => {
    const { ir, go } = contractsFor(['# language: es', 'Característica: Pagos', '  Escenario: Pago', '    Dado un cliente', '    Cuando paga', '    Entonces queda registrado'].join('\n'));
    expect(ir.events).toHaveLength(0);
    expect(go).not.toContain('github.com/google/uuid');
  });

  it('imports uuid when events use it', () => {
    const parsed = parseGherkinText(['Feature: Orders', '  Scenario: Place', '    Given a customer', '    When the customer places an order', '    Then the order is stored'].join('\n'));
    const ir = { ...buildIR(parsed, 'f.feature'), events: [{ name: 'OrderPlaced' }] } as any;
    const go = generateGoContracts(parsed, ir, config);
    expect(go).toContain('"github.com/google/uuid"');
    expect(go).toContain('uuid.UUID');
  });
});
