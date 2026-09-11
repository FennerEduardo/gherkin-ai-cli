import { describe, it, expect } from 'vitest';
import { validateFinancialGates } from '../../../src/core/validators/financial-gates';

describe('validateFinancialGates', () => {
  it('should ignore if rule is not active', () => {
    const result = validateFinancialGates({
      rules: [],
      files: [{ path: 'src/log.ts', content: 'console.log("password")' }]
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(0);
  });

  it('should warn on PII or secrets in logs', () => {
    const result = validateFinancialGates({
      rules: ['pci-dss-compliance'],
      files: [{ path: 'src/log.ts', content: 'logger.info(`user password is ${pass}`)' }]
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Data leak risk');
  });

  it('should fail on unmasked card data', () => {
    const result = validateFinancialGates({
      rules: ['pci-dss-compliance'],
      files: [{ path: 'src/payment.ts', content: 'const creditcard = req.body.pan;' }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('PCI-DSS Violation');
  });

  it('should pass if card data is masked', () => {
    const result = validateFinancialGates({
      rules: ['pci-dss-compliance'],
      files: [{ path: 'src/payment.ts', content: 'const creditcard = obfuscate(req.body.pan);' }]
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
