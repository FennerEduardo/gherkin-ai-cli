import { ValidatorContext, ValidationResult } from './index';
import { tf } from '../../utils/i18n-cli';

export function validateJavaSpring(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  const javaFiles = context.files.filter(f => f.path.endsWith('.java'));
  if (javaFiles.length === 0) return result;

  for (const file of javaFiles) {
    const content = file.content;

    // 1. Validar uso de @Transactional en operaciones de modificación o Outbox
    if (content.includes('OutboxRepository') && !content.includes('@Transactional')) {
      result.warnings.push(tf('valJavaOutboxNoTx', { file: file.path }));
    }

    // 2. Comprobar que los DTOs o Controllers no expongan datos de tarjeta o PII sin masking
    if (content.includes('cardNumber') || content.includes('cvv')) {
      if (!content.includes('mask') && !content.includes('Transient') && !content.includes('JsonIgnore')) {
        result.errors.push(tf('valJavaPciExposure', { file: file.path }));
        result.valid = false;
      }
    }

    // 3. Advertencia si no hay propagación de Trace ID / Correlation ID en Handlers
    if (content.includes('@RestController') || content.includes('@KafkaListener') || /^@Path\(/m.test(content)) {
      if (!content.includes('traceId') && !content.includes('correlationId') && !content.includes('X-Trace-Id')) {
        result.warnings.push(tf('valJavaNoTrace', { file: file.path }));
      }
    }
  }

  return result;
}
