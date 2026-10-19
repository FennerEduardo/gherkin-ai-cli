import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { lintSpecification } from '../../src/core/specification-linter';
import { explainIr } from '../../src/core/ir-explain';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';

const spanish = (tags = '') => parseGherkinText([
  '# language: es',
  `${tags}`,
  'Característica: Ejecución de pagos',
  '  Escenario: Pago aceptado',
  '    Cuando el Debtor ejecuta el pago',
  '    Entonces el pago queda aceptado',
  '  @command:RefundPayment',
  '  Escenario: Reembolso',
  '    Cuando el Creditor devuelve el pago',
  '    Entonces el pago queda reembolsado'
].join('\n'));

describe('explicit IR annotations (@command, @event)', () => {
  it('without tags, a Spanish feature gets the generic command and GHK016 says so', () => {
    const parsed = spanish('@aggregate:PaymentExecution');
    // The scenario tag alone declares one command; drop it to see the generic fallback.
    const untagged = { ...parsed, scenarios: parsed.scenarios.map(sc => ({ ...sc, tags: [] })) };
    expect(buildDomainModel(untagged).commands.map(c => c.snake)).toEqual(['process_payment_execution']);
    expect(lintSpecification(untagged, 'pay.feature').diagnostics.some(d => d.ruleId === 'GHK016')).toBe(true);
    expect(explainIr(untagged, 'pay.feature').commands[0].source).toBe('default');
  });

  it('tags name the commands and events in any dialect, in the IR and in the generated code', () => {
    const parsed = spanish('@aggregate:PaymentExecution @command:ExecutePayment @event:PaymentExecuted @event:PaymentRefunded');
    const m = buildDomainModel(parsed);
    expect(m.commands.map(c => [c.snake, c.event])).toEqual([['execute_payment', 'PaymentExecuted'], ['refund_payment', 'PaymentRefunded']]);
    const ir = buildIR(parsed, 'pay.feature');
    expect(ir.commands.map(c => [c.name, c.inferenceSource, c.confidence])).toEqual([['execute_payment', 'user', 1], ['refund_payment', 'user', 1]]);
    expect(ir.events.map(e => e.name)).toEqual(['PaymentExecuted', 'PaymentRefunded']);
    // The scenario tagged @command:RefundPayment is linked to that command only.
    const refund = ir.scenarios.find(s => s.name === 'Reembolso')!;
    expect(refund.commands).toEqual([ir.commands[1].id]);
    expect(lintSpecification(parsed, 'pay.feature').diagnostics.some(d => d.ruleId === 'GHK016')).toBe(false);
    const x = explainIr(parsed, 'pay.feature');
    expect(x).toMatchObject({ aggregate: { name: 'PaymentExecution', source: 'tag' }, route: 'POST /api/v1/payment-execution/{id}/{command}' });
    expect(x.commands.every(c => c.source === 'tag')).toBe(true);
    expect(x.suggestions).toEqual([]);
  });
});
