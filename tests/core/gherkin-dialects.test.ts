import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';

describe('Gherkin dialects', () => {
  it('parses a "# language: es" feature as Gherkin, not as Markdown', () => {
    const parsed = parseGherkinText([
      '# language: es',
      'Característica: Creación de Pedidos',
      '',
      '  Escenario: Pedido pagado',
      '    Dado que existe un cliente activo',
      '    Y la pasarela de pago está disponible',
      '    Cuando se envía el comando de pago',
      '    Entonces el pedido queda pagado',
      '    Pero no se notifica dos veces'
    ].join('\n'));
    expect(parsed.featureName).toBe('Creación de Pedidos');
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0].steps.map(s => s.keyword)).toEqual(['Given', 'And', 'When', 'Then', 'But']);
    const m = buildDomainModel(parsed);
    expect(m.pascal).toBe('CreacionDePedidos');
    expect(m.kebab).toBe('creacion-de-pedidos');
    expect(m.commands.map(c => c.name)).toEqual(['ProcessCreacionDePedidos']);
  });

  it('uses command identifiers named in When steps and splits one-letter words', () => {
    const m = buildDomainModel(parseGherkinText([
      '# language: es',
      'Característica: Pedidos en NestJS y Renderizado NextJS',
      '  Escenario: Pago',
      '    Dado un cliente',
      '    Cuando se envía el comando "CreateOrderCommand" con monto 250.00',
      '    Y MediatR envía el comando al Handler "CapturePaymentCommandHandler"',
      '    Entonces el pedido queda pagado'
    ].join('\n')));
    expect(m.commands.map(c => c.name)).toEqual(['CreateOrder', 'CapturePayment']);
    expect(m.kebab).toBe('pedidos-en-nest-js-y-renderizado-next-js');
  });

  it('maps keywords of other dialects through their keyword type', () => {
    const parsed = parseGherkinText([
      '# language: fr',
      'Fonctionnalité: Commande',
      '  Scénario: Paiement',
      '    Soit un client',
      '    Quand il paie',
      '    Alors la commande est payée'
    ].join('\n'));
    expect(parsed.scenarios[0].steps.map(s => s.keyword)).toEqual(['Given', 'When', 'Then']);
  });

  it('accepts a leading comment before an English feature', () => {
    const parsed = parseGherkinText('# owner: payments team\nFeature: Refunds\n  Scenario: Refund\n    Given a paid order\n    When a refund is requested\n    Then the order is refunded');
    expect(parsed.featureName).toBe('Refunds');
  });
});
