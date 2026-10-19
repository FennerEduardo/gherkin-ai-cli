import { describe, it, expect } from 'vitest';
import { generateJavaOpenTelemetryInfrastructure } from '../src/generators/java/java-opentelemetry-generator';
import { validateJavaSpring } from '../src/core/validators/java-spring-validator';
import { generateJavaSpringPreset, jvmBasePackage, jvmGroupId } from '../src/generators/preset-java-spring';
import { parseGherkinText } from '../src/core/gherkin-parser';

const FEATURE = parseGherkinText(`Feature: Payment Process
  Scenario: Pay
    When the customer pays the order
    Then the order is paid
`);

describe('Java Spring generators & validator', () => {
  it('generateJavaOpenTelemetryInfrastructure creates OTLP configuration', () => {
    const code = generateJavaOpenTelemetryInfrastructure('com.example.app', 'orders');
    expect(code).toContain('class OpenTelemetryConfig');
    // OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is set; service.name from OTEL_SERVICE_NAME.
    expect(code).toContain('OtlpHttpSpanExporter');
    expect(code).toContain('System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")');
    expect(code).toContain('getOrDefault("OTEL_SERVICE_NAME", "orders")');
  });

  it('wires the application layer to the runtime kernel instead of placeholder patterns', () => {
    const files = generateJavaSpringPreset(FEATURE);
    const names = files.map(f => f.filename);
    expect(names.some(f => f.endsWith('/api/PaymentProcessController.java'))).toBe(true);
    expect(names.some(f => f.endsWith('/auth/JwtTenantFilter.java'))).toBe(true);
    expect(names.some(f => f.endsWith('/runtime/RuntimeConfiguration.java'))).toBe(true);
    expect(names).toContain('src/main/resources/application.properties');
    // The disconnected 3.0 placeholders (JPA outbox, saga, CQRS handlers, X-Tenant-Id filter) are gone.
    expect(names.some(f => /OutboxService|SagaOrchestrator\.java$|CommandHandler|TenantContext/.test(f) && !f.includes('/runtime/'))).toBe(false);

    const all = files.map(f => f.content).join('\n');
    expect(all).not.toMatch(/X-Tenant-Id"\s*\)/);
    const controller = files.find(f => f.filename.endsWith('Controller.java'))!.content;
    expect(controller).toContain('@RequestAttribute(JwtTenantFilter.TENANT_ATTRIBUTE)');
    expect(controller).toContain('commands.handle(');
  });

  it('honours generation.package and generation.groupId', () => {
    const config = { projectName: 'shop', generation: { package: 'org.acme.billing' } } as any;
    expect(jvmBasePackage(config)).toBe('org.acme.billing');
    expect(jvmGroupId(config)).toBe('org.acme');
    expect(jvmGroupId({ ...config, generation: { ...config.generation, groupId: 'org.acme.platform' } })).toBe('org.acme.platform');
    expect(generateJavaSpringPreset(FEATURE, config).some(f => f.filename.startsWith('src/main/java/org/acme/billing/api/'))).toBe(true);
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
