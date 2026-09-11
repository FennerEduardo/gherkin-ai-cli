import { ValidatorContext, ValidationResult } from './index';

export function validateFinancialGates(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  if (!context.rules.includes('pci-dss-compliance')) {
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
          result.warnings.push(`Riesgo de fuga de datos / Data leak risk: Posible registro de datos sensibles (PII/Secretos) en logs en la línea ${index + 1} del archivo ${file.path} / Possible logging of sensitive data (PII/Secrets) at line ${index + 1} of file ${file.path}.`);
        }
      }

      // Detección de tipos de datos de tarjetas sin tokenización (PCI-DSS) / Detect un-tokenized card data
      if (cardKeywords.some(kw => lowerLine.includes(kw))) {
        if (!lowerLine.includes('token') && !lowerLine.includes('mask') && !lowerLine.includes('obfuscate')) {
          result.errors.push(`Violación PCI-DSS / PCI-DSS Violation: Referencia a datos de tarjeta sin evidencia de tokenización/enmascaramiento en la línea ${index + 1} de ${file.path} / Reference to card data without evidence of tokenization/masking at line ${index + 1} of ${file.path}.`);
          result.valid = false;
        }
      }
    });
  });

  return result;
}
