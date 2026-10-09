import { ValidatorContext, ValidationResult } from './index';
import { tf } from '../../utils/i18n-cli';

export function validateFinancialGates(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  if (!context.rules.includes('pci-dss-compliance') && !context.rules.includes('payments') && !context.rules.includes('fintech')) {
    return result; // Skip if not in financial profile
  }

  const piiKeywords = ['password', 'secret', 'apikey', 'creditcard', 'cvv', 'pan'];
  const cardKeywords = ['creditcard', 'debitcard', 'pan', 'cardnumber'];

  context.files.forEach(file => {
    const lines = file.content.split('\n');

    lines.forEach((line, index) => {
      const lowerLine = line.toLowerCase();
      
      // Detección de secretos o PII en logs / Detect secrets or PII in logs
      if (lowerLine.includes('logger.') || lowerLine.includes('console.log')) {
        if (piiKeywords.some(kw => lowerLine.includes(kw))) {
          result.warnings.push(tf('valFinancialPiiLog', { line: index + 1, file: file.path }));
        }
      }

      // Detección de tipos de datos de tarjetas sin tokenización (PCI-DSS) / Detect un-tokenized card data
      if (cardKeywords.some(kw => lowerLine.includes(kw))) {
        if (!lowerLine.includes('token') && !lowerLine.includes('mask') && !lowerLine.includes('obfuscate')) {
          result.errors.push(tf('valFinancialCardData', { line: index + 1, file: file.path }));
          result.valid = false;
        }
      }
    });
  });

  return result;
}
