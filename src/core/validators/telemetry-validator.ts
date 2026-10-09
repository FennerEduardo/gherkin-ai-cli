import { ValidatorContext, ValidationResult } from './index';
import { tf } from '../../utils/i18n-cli';

export function validateTelemetry(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  if (!context.rules.includes('opentelemetry')) {
    return result; // Skip if opentelemetry rule is not active
  }

  const hasContracts = context.files.some(f => f.path.includes('contracts') || f.path.endsWith('.json'));

  if (!hasContracts) return result;

  context.files.forEach(file => {
    // Only check JSON or TS contracts / Solo revisar contratos JSON o TS
    if (file.path.endsWith('.json') || file.path.includes('contract')) {
      const content = file.content.toLowerCase();
      
      if (content.includes('asyncapi') || content.includes('openapi')) {
        if (!content.includes('correlationid') && !content.includes('traceid')) {
          result.errors.push(tf('valTelemetryNoTraceHeaders', { file: file.path }));
          result.valid = false;
        }
      }
    }
  });

  return result;
}
