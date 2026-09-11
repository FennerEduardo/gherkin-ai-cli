import { describe, it, expect } from 'vitest';
import { runAllValidators, ValidatorContext } from '../../src/core/validators/index';

describe('Integration: New Features Validators', () => {
  it('should process a realistic project structure and detect multiple violations across different validators', () => {
    // Escenario: Un proyecto "sucio" con múltiples violaciones de arquitectura,
    // seguridad y observabilidad.
    // Scenario: A "dirty" project with multiple architecture, security, and observability violations.
    
    const context: ValidatorContext = {
      rules: ['strictLayerBoundaries', 'pci-dss-compliance', 'opentelemetry'],
      files: [
        // .NET Domain file with DB dependency
        { path: 'src/Domain/Payment.cs', content: 'using Microsoft.EntityFrameworkCore;\npublic class Payment { }' },
        
        // .NET Query with state modification
        { path: 'src/Application/Queries/GetPayment.cs', content: 'public void Handle() { DbContext.SaveChanges(); }' },
        
        // Angular component injecting HttpClient directly
        { path: 'frontend/src/app/payment.component.ts', content: 'import { HttpClient } from "@angular/common/http";\n@Component({})\nexport class PaymentComponent { constructor(private http: HttpClient) {} }' },
        
        // C4 diagram missing ContainerDb but code has DbContext
        { path: 'docs/architecture.md', content: 'C4Context\nContainer(api, "API")\n// No DB defined here' },
        
        // Financial Gates: Unmasked card data
        { path: 'src/Application/Commands/ProcessPayment.cs', content: 'var creditcard = request.PAN;' },
        
        // Financial Gates: PII in logs
        { path: 'src/Infrastructure/Logging/AuditLogger.cs', content: 'logger.LogInformation($"User password is {user.Password}");' },
        
        // Telemetry: Contract missing correlationId
        { path: 'generated/contracts.json', content: '{"asyncapi": "2.6.0", "info": {"title": "Payments"}}' }
      ]
    };

    const result = runAllValidators(context);

    // Assert that the overall validation fails
    expect(result.valid).toBe(false);

    // Assert DotNet CQRS violations
    expect(result.errors.some(e => e.includes('Layer violation') && e.includes('Domain'))).toBe(true);
    expect(result.errors.some(e => e.includes('CQRS Violation') && e.includes('SaveChanges'))).toBe(true);

    // Assert Angular violations
    expect(result.errors.some(e => e.includes('Architectural violation') && e.includes('HttpClient'))).toBe(true);

    // Assert C4 Sync violations
    expect(result.errors.some(e => e.includes('C4 Inconsistency'))).toBe(true);

    // Assert Financial Gates violations
    expect(result.warnings.some(w => w.includes('Data leak risk') && w.includes('PII/Secrets'))).toBe(true);
    expect(result.errors.some(e => e.includes('PCI-DSS Violation') && e.includes('tokenization'))).toBe(true);

    // Assert Telemetry violations
    expect(result.errors.some(e => e.includes('Observability Violation') && e.includes('correlationId'))).toBe(true);
  });

  it('should pass on a clean, compliant project structure', () => {
    // Escenario: Un proyecto "limpio" que respeta todas las reglas.
    // Scenario: A "clean" project that respects all rules.
    
    const context: ValidatorContext = {
      rules: ['strictLayerBoundaries', 'pci-dss-compliance', 'opentelemetry'],
      files: [
        { path: 'src/Domain/Payment.cs', content: 'public class Payment { }' },
        { path: 'src/Application/Queries/GetPayment.cs', content: 'public Payment Dto Handle() { return new Dto(); }' },
        { path: 'frontend/src/app/payment.component.ts', content: 'import { Store } from "@ngrx/store";\n@Component({})\nexport class PaymentComponent { constructor(private store: Store) { this.store.dispatch(a()); } }' },
        { path: 'docs/architecture.md', content: 'C4Context\nContainerDb(db, "Database")' },
        { path: 'src/Application/Commands/ProcessPayment.cs', content: 'var tokenizedCard = obfuscate(request.PAN);' },
        { path: 'generated/contracts.json', content: '{"asyncapi": "2.6.0", "info": {"title": "Payments"}, "correlationId": "uuid"}' }
      ]
    };

    const result = runAllValidators(context);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
