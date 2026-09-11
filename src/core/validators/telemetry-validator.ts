import { ValidatorContext, ValidationResult } from './index';

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
          result.errors.push(`Violación de Observabilidad / Observability Violation: El contrato (${file.path}) no incluye headers de trazabilidad distribuida (correlationId o traceId) / The contract (${file.path}) does not include distributed tracing headers (correlationId or traceId).`);
          result.valid = false;
        }
      }
    }
  });

  return result;
}
