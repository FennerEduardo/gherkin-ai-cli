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
    const code = generateJavaOutboxInfrastructure('com.example.app').map(f => f.content).join('\\n');
    expect(code).toContain('class OutboxMessage');
    expect(code).toContain('@Transactional');
    expect(code).toContain('OutboxStatus');
    expect(code).toContain('processOutbox');
  });

  it('generateJavaSagaInfrastructure creates persisted Saga orchestrator code', () => {
    const code = generateJavaSagaInfrastructure('com.example.app').map(f => f.content).join('\\n');
    expect(code).toContain('SagaInstance');
    expect(code).toContain('PaymentSagaOrchestrator');
    expect(code).toContain('SagaState.COMPENSATING');
    expect(code).toContain('InitiatedEvent');
  });

  it('generateJavaSagaInfrastructure supports custom feature names', () => {
    const files = generateJavaSagaInfrastructure('com.example.app', 'Order Fulfillment');
    const code = files.map(f => f.content).join('\\n');
    expect(code).toContain('OrderFulfillmentSagaOrchestrator');
    expect(code).toContain('OrderFulfillmentSagaContract');
    expect(files.some(f => f.filename.includes('OrderFulfillment'))).toBe(true);
  });

  it('generateJavaIdempotencyInfrastructure creates HTTP filter & JPA record', () => {
    const code = generateJavaIdempotencyInfrastructure('com.example.app').map(f => f.content).join('\\n');
    expect(code).toContain('class IdempotencyFilter');
    expect(code).toContain('X-Idempotency-Key');
    expect(code).toContain('uk_idempotency_key');
  });

  it('generateJavaOpenTelemetryInfrastructure creates OTLP configuration', () => {
    const code = generateJavaOpenTelemetryInfrastructure('com.example.app');
    expect(code).toContain('class OpenTelemetryConfig');
    expect(code).toContain('OtlpGrpcSpanExporter');
  });

  it('generateJavaCQRSInfrastructure creates Command & Query handlers (separate files)', () => {
    const files = generateJavaCQRSInfrastructure('com.example.app');
    const code = files.map(f => f.content).join('\\n');
    expect(files.length).toBe(6); // One file per public class
    expect(code).toContain('CreatePaymentCommandHandler');
    expect(code).toContain('GetPaymentQueryHandler');
    expect(code).toContain('ApplicationEventPublisher');
    // Verify each file has exactly one public class/record
    for (const file of files) {
      expect(file.filename.endsWith('.java')).toBe(true);
    }
  });

  it('generateJavaCQRSInfrastructure supports custom feature names', () => {
    const files = generateJavaCQRSInfrastructure('com.example.app', 'Inventory Management');
    const code = files.map(f => f.content).join('\\n');
    expect(code).toContain('CreateInventoryManagementCommandHandler');
    expect(code).toContain('GetInventoryManagementQueryHandler');
    expect(files.some(f => f.filename.includes('InventoryManagement'))).toBe(true);
  });

  it('generateJavaSpringPreset produces expected files with feature-based names', () => {
    const mockParsed = {
      featureName: 'PaymentProcess',
      scenarios: []
    };
    // @ts-ignore
    const files = generateJavaSpringPreset(mockParsed);
    // CQRS now generates 6 files instead of 1, so total increases by 5
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some(f => f.filename.includes('OutboxService.java'))).toBe(true);
    expect(files.some(f => f.filename.includes('PaymentProcessSagaOrchestrator.java'))).toBe(true);
    expect(files.some(f => f.filename.includes('CreatePaymentProcessCommandHandler.java'))).toBe(true);
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
