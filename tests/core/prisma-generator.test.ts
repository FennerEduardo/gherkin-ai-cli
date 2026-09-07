import { describe, it, expect } from 'vitest';
import { generatePrismaSchema, isPrismaInstalled } from '../../src/generators/prisma-generator';
import { defaultConfig } from '../../src/core/config';
import { SpecificationIR } from '../../src/core/semantic-ir';

describe('Prisma Generator', () => {
  it('should generate valid Prisma schema with enum and models from IR', () => {
    const mockIR: Partial<SpecificationIR> = {
      version: '1.0.0',
      featureName: 'Order Processing',
      actors: [{ id: 'act-1', name: 'Customer', role: 'customer', permissions: [], scenarios: [], source: { file: 'features/order.feature', line: 1 }, confidence: 1, inferenceSource: 'deterministic' }],
      commands: [
        {
          id: 'cmd-1',
          name: 'Create Order',
          verb: 'create',
          subject: 'Order',
          inputFields: [
            { name: 'amount', type: 'number', required: true, validations: [], exampleValues: [] },
            { name: 'shippingAddress', type: 'string', required: true, validations: [], exampleValues: [] }
          ],
          preconditions: [],
          postconditions: [],
          triggeredBy: 'act-1',
          emittedEvents: [],
          source: { file: 'features/order.feature', line: 5 },
          confidence: 1,
          inferenceSource: 'deterministic'
        }
      ],
      queries: [],
      events: [],
      stateMachines: [
        {
          entity: 'Order',
          states: ['PENDING', 'PAID', 'SHIPPED', 'CANCELLED'],
          initialState: 'PENDING',
          finalStates: ['SHIPPED', 'CANCELLED'],
          transitions: []
        }
      ]
    };

    const schema = generatePrismaSchema(mockIR as SpecificationIR, defaultConfig);
    expect(schema).toContain('datasource db {');
    expect(schema).toContain('enum OrderStatus {');
    expect(schema).toContain('PENDING');
    expect(schema).toContain('CANCELLED');
    expect(schema).toContain('model Order {');
    expect(schema).toContain('id String @id @default(uuid())');
    expect(schema).toContain('amount Int');
    expect(schema).toContain('status OrderStatus');
  });

  it('should return false for isPrismaInstalled in non-prisma directory', () => {
    expect(isPrismaInstalled(__dirname)).toBe(false);
  });
});
