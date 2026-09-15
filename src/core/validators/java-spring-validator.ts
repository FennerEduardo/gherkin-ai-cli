import { ValidatorContext, ValidationResult } from './index';

export function validateJavaSpring(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  const javaFiles = context.files.filter(f => f.path.endsWith('.java'));
  if (javaFiles.length === 0) return result;

  for (const file of javaFiles) {
    const content = file.content;

    // 1. Validar uso de @Transactional en operaciones de modificación o Outbox
    if (content.includes('OutboxRepository') && !content.includes('@Transactional')) {
      result.warnings.push(`[Java-Spring] El archivo ${file.path} usa OutboxRepository pero no especifica @Transactional.`);
    }

    // 2. Comprobar que los DTOs o Controllers no expongan datos de tarjeta o PII sin masking
    if (content.includes('cardNumber') || content.includes('cvv')) {
      if (!content.includes('mask') && !content.includes('Transient') && !content.includes('JsonIgnore')) {
        result.errors.push(`[Java-Spring-Security] Posible exposición de datos PCI-DSS en ${file.path} sin masking ni @JsonIgnore.`);
        result.valid = false;
      }
    }

    // 3. Advertencia si no hay propagación de Trace ID / Correlation ID en Handlers
    if (content.includes('@RestController') || content.includes('@KafkaListener')) {
      if (!content.includes('traceId') && !content.includes('correlationId') && !content.includes('X-Trace-Id')) {
        result.warnings.push(`[Java-Spring-Telemetry] El componente ${file.path} no parece propagar traceId ni correlationId.`);
      }
    }
  }

  return result;
}
