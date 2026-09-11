import { describe, it, expect } from 'vitest';
import { generateOutboxInfrastructure } from '../../src/generators/dotnet/outbox-generator';
import { generateIdempotencyInfrastructure } from '../../src/generators/dotnet/idempotency-generator';
import { generateSagaInfrastructure } from '../../src/generators/dotnet/saga-generator';
import { generateOpenTelemetryConfig } from '../../src/generators/dotnet/opentelemetry-generator';

describe('DotNet Pattern Generators', () => {
  const ns = 'TestNamespace';

  it('should generate Outbox infrastructure', () => {
    const code = generateOutboxInfrastructure(ns);
    expect(code).toContain('namespace TestNamespace.Infrastructure.Outbox');
    expect(code).toContain('public class OutboxMessage');
    expect(code).toContain('public class OutboxService : IOutboxService');
    expect(code).toContain('DbContext');
  });

  it('should generate Idempotency infrastructure', () => {
    const code = generateIdempotencyInfrastructure(ns);
    expect(code).toContain('namespace TestNamespace.Application.Behaviors');
    expect(code).toContain('public interface IIdempotencyStore');
    expect(code).toContain('public class IdempotentBehavior');
    expect(code).toContain('IPipelineBehavior');
  });

  it('should generate Saga infrastructure', () => {
    const code = generateSagaInfrastructure(ns);
    expect(code).toContain('namespace TestNamespace.Application.Sagas');
    expect(code).toContain('public class PaymentSagaState : SagaStateMachineInstance');
    expect(code).toContain('public class PaymentSagaStateMachine : MassTransitStateMachine<PaymentSagaState>');
    expect(code).toContain('CancelAuthorizationCommand');
  });

  it('should generate OpenTelemetry config', () => {
    const code = generateOpenTelemetryConfig(ns);
    expect(code).toContain('namespace TestNamespace.Infrastructure.Telemetry');
    expect(code).toContain('AddOpenTelemetry');
    expect(code).toContain('AddOtlpExporter');
  });
});
