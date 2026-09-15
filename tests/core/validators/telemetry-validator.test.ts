import { describe, it, expect } from 'vitest';
import { validateTelemetry } from '../../../src/core/validators/telemetry-validator';

describe('validateTelemetry', () => {
  it('should pass if opentelemetry rule is missing', () => {
    const result = validateTelemetry({
      rules: [],
      files: [{ path: 'contracts.json', content: '{"asyncapi": "2.0.0"}' }]
    });
    expect(result.valid).toBe(true);
  });

  it('should fail if contract lacks tracing headers', () => {
    const result = validateTelemetry({
      rules: ['opentelemetry'],
      files: [{ path: 'contracts.json', content: '{"asyncapi": "2.0.0"}' }]
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Observability Violation');
  });

  it('should pass if contract has correlationId', () => {
    const result = validateTelemetry({
      rules: ['opentelemetry'],
      files: [{ path: 'contracts.json', content: '{"asyncapi": "2.0.0", "correlationId": "uuid"}' }]
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});
