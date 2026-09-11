import { describe, it, expect } from 'vitest';
import { generateJavaOutboxInfrastructure } from '../src/generators/java/java-outbox-generator';
import { generateJavaSagaInfrastructure } from '../src/generators/java/java-saga-generator';
import { generateJavaIdempotencyInfrastructure } from '../src/generators/java/java-idempotency-generator';
import { generateJavaOpenTelemetryInfrastructure } from '../src/generators/java/java-opentelemetry-generator';
import { generateJavaCQRSInfrastructure } from '../src/generators/java/java-cqrs-generator';
import { validateJavaSpring } from '../src/core/validators/java-spring-validator';
import { generateJavaSpringPreset } from '../src/generators/preset-java-spring';

describe('Java Distributed Generators & Spring Validator', () => {

  it('generateJavaOutboxInfrastructure creates valid JPA Outbox code', () => {
    const code = generateJavaOutboxInfrastructure('com.example.app');
    expect(code).toContain('class OutboxMessage');
    expect(code).toContain('@Transactional');
    expect(code).toContain('OutboxStatus');
    expect(code).toContain('processOutbox');
  });

  it('generateJavaSagaInfrastructure creates persisted Saga orchestrator code', () => {
    const code = generateJavaSagaInfrastructure('com.example.app');
    expect(code).toContain('class SagaInstance');
    expect(code).toContain('PaymentSagaOrchestrator');
    expect(code).toContain('SagaState.COMPENSATING');
    expect(code).toContain('record PaymentInitiatedEvent');
  });

  it('generateJavaIdempotencyInfrastructure creates HTTP filter & JPA record', () => {
    const code = generateJavaIdempotencyInfrastructure('com.example.app');
    expect(code).toContain('class IdempotencyFilter');
    expect(code).toContain('X-Idempotency-Key');
    expect(code).toContain('uk_idempotency_key');
  });

  it('generateJavaOpenTelemetryInfrastructure creates OTLP configuration', () => {
    const code = generateJavaOpenTelemetryInfrastructure('com.example.app');
    expect(code).toContain('class OpenTelemetryConfig');
    expect(code).toContain('OtlpGrpcSpanExporter');
  });

  it('generateJavaCQRSInfrastructure creates Command & Query handlers', () => {
    const code = generateJavaCQRSInfrastructure('com.example.app');
    expect(code).toContain('CreatePaymentCommandHandler');
    expect(code).toContain('GetPaymentQueryHandler');
    expect(code).toContain('ApplicationEventPublisher');
  });

  it('generateJavaSpringPreset produces all 6 expected files', () => {
    const mockParsed = {
      featureName: 'PaymentProcess',
      scenarios: []
    };
    // @ts-ignore
    const files = generateJavaSpringPreset(mockParsed);
    expect(files.length).toBe(6);
    expect(files.some(f => f.filename.includes('OutboxInfrastructure.java'))).toBe(true);
    expect(files.some(f => f.filename.includes('PaymentSagaOrchestrator.java'))).toBe(true);
  });

  it('validateJavaSpring detects missing @Transactional and PCI-DSS vulnerabilities', () => {
    const context = {
      files: [
        {
          path: 'PaymentService.java',
          content: 'public class PaymentService { private OutboxRepository repo; public void process() { repo.save(null); } }'
        },
        {
          path: 'CardDTO.java',
          content: 'public class CardDTO { private String cardNumber; private String cvv; }'
        }
      ],
      rules: []
    };

    const result = validateJavaSpring(context);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('PCI-DSS'))).toBe(true);
    expect(result.warnings.some(w => w.includes('@Transactional'))).toBe(true);
  });
});
