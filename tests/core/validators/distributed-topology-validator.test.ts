import { describe, it, expect } from 'vitest';
import { validateDistributedTopology } from '../../../src/core/validators/distributed-topology-validator';
import { ValidatorContext } from '../../../src/core/validators/index';

describe('Distributed Topology Validator', () => {
  it('should warn when CQRS events exist without outbox', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'handler.cs', content: 'public class CreatePaymentCommandHandler { IDomainEvent event; }' }
      ],
      rules: ['cqrs']
    };

    const result = validateDistributedTopology(context);
    expect(result.warnings.some(w => w.includes('Outbox'))).toBe(true);
  });

  it('should warn when retry logic exists without DLQ', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'processor.ts', content: 'const maxRetries = 5; if (retryCount >= maxRetries) throw error;' }
      ],
      rules: []
    };

    const result = validateDistributedTopology(context);
    expect(result.warnings.some(w => w.includes('DLQ') || w.includes('Dead Letter'))).toBe(true);
  });

  it('should warn when saga exists without compensation commands', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'saga.cs', content: 'public class PaymentSagaStateMachine { SagaState state; }' }
      ],
      rules: []
    };

    const result = validateDistributedTopology(context);
    expect(result.warnings.some(w => w.includes('compensation'))).toBe(true);
  });

  it('should warn when tenantId is in commands but not events', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'command.ts', content: 'export class CreatePaymentCommand { tenantId: string; }' },
        { path: 'event.ts', content: 'export class PaymentCreatedEvent { paymentId: string; }' }
      ],
      rules: []
    };

    const result = validateDistributedTopology(context);
    expect(result.warnings.some(w => w.includes('TenantId') || w.includes('tenant'))).toBe(true);
  });

  it('should warn when CQRS events exist without projections', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'handler.ts', content: 'class CreatePaymentCommandHandler { IDomainEvent event; emit() {} }' }
      ],
      rules: ['cqrs']
    };

    const result = validateDistributedTopology(context);
    expect(result.warnings.some(w => w.includes('projection') || w.includes('read model'))).toBe(true);
  });

  it('should pass clean for complete distributed topology', () => {
    const context: ValidatorContext = {
      files: [
        { path: 'handler.cs', content: 'public class CommandHandler { IDomainEvent event; OutboxMessage msg; }' },
        { path: 'outbox.cs', content: 'public class OutboxService { OutboxMessage ProcessOutbox() {} }' },
        { path: 'saga.cs', content: 'public class PaymentSagaStateMachine { SagaState Compensating; CancelAuthorizationCommand Cancel; }' },
        { path: 'dlq.cs', content: 'DLQ DeadLetterQueue; retryCount; maxRetries;' },
        { path: 'projection.cs', content: 'public class PaymentProjection : ReadModel { }' },
        { path: 'command.ts', content: 'export class CreatePaymentCommand { tenantId: string; }' },
        { path: 'event.ts', content: 'export class PaymentCreatedEvent { tenantId: string; DomainEvent; }' }
      ],
      rules: ['cqrs']
    };

    const result = validateDistributedTopology(context);
    expect(result.valid).toBe(true);
    // May still have minor warnings but no critical errors
    expect(result.errors).toHaveLength(0);
  });
});
