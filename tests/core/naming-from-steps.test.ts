import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR } from '../../src/core/ir-builder';
import { lintSpecification } from '../../src/core/specification-linter';
import { generatePrismaStack } from '../../src/generators/prisma-stack';

const REGISTRATION = `Feature: User registration
  Scenario: Register
    Given a visitor
    When the visitor registers with email "ana@example.edu"
    Then the account status becomes "active"
    And the user is enrolled in "Spring 2026"
    And the data is stored:
      | email           | role    |
      | ana@example.edu | student |
`;

describe('names do not come from example data', () => {
  const parsed = parseGherkinText(REGISTRATION);

  it('takes fields from the table header and from nouns before quoted values only', () => {
    const fields = parsed.domainAnalysis.fields.map(f => f.name).sort();
    expect(fields).toEqual(['email', 'role']);
  });

  it('never builds a command name from a quoted value', () => {
    const names = buildIR(parsed, 'registration.feature').commands.map(c => c.name);
    expect(names.join(' ')).not.toMatch(/anaexample|edu|2026/);
  });

  it('GHK015 flags a command named after example data', () => {
    const bad = parseGherkinText(`Feature: Orders 2026
  Scenario: Place
    When the customer creates www shop
    Then the shop is created
`);
    const messages = lintSpecification(bad, 'orders.feature').diagnostics.filter(d => d.ruleId === 'GHK015').map(d => d.message);
    expect(messages).toEqual([expect.stringContaining('Aggregate name "Orders2026" contains digits'), expect.stringContaining('looks like example data')]);
    expect(lintSpecification(parsed, 'registration.feature').diagnostics.filter(d => d.ruleId === 'GHK015')).toEqual([]);
  });
});

describe('Prisma schema of a multi-feature service', () => {
  it('has one model per feature', () => {
    const config = { projectName: 'shop', stack: { language: 'typescript', framework: 'nestjs', orm: 'prisma', database: 'postgresql' } } as any;
    const orders = parseGherkinText('Feature: Orders\n  Scenario: a\n    When the customer places an order\n    Then the order is placed\n');
    const refunds = parseGherkinText('Feature: Refunds\n  Scenario: a\n    When the customer requests a refund\n    Then the refund is requested\n');
    const schema = generatePrismaStack(refunds, config, [orders]).find(a => a.filename === 'prisma/schema.prisma')!.content;
    expect(schema).toContain('model Orders {');
    expect(schema).toContain('model Refunds {');
  });
});
