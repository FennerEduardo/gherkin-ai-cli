import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateAsyncAPISpec, validateAsyncAPIAgainstIR } from '../../src/core/asyncapi-validator';
import { SpecificationIR } from '../../src/core/semantic-ir';

function createTempFile(content: string, ext: string = '.json'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asyncapi-test-'));
  const filePath = path.join(tmpDir, `spec${ext}`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function cleanupFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch { /* ignore */ }
}

describe('AsyncAPI Validator', () => {
  const validSpec = {
    asyncapi: '2.6.0',
    info: { title: 'Test AsyncAPI', version: '1.0.0' },
    channels: {
      'payments/events/paymentinitiated': {
        bindings: {
          rabbitmq: {
            is: 'routingKey',
            queue: { name: 'payment.queue', durable: true, exclusive: false, autoDelete: false },
            bindingVersion: '0.2.0'
          },
          kafka: {
            topic: 'payments.initiated',
            partitions: 3,
            replicas: 2,
            bindingVersion: '0.3.0'
          }
        },
        publish: {
          summary: 'Publish PaymentInitiated event',
          message: {
            name: 'PaymentInitiated',
            correlationId: {
              description: 'Correlation ID',
              location: '$message.header#/correlationId'
            },
            headers: {
              type: 'object',
              properties: {
                correlationId: { type: 'string', format: 'uuid' },
                causationId: { type: 'string', format: 'uuid' },
                schemaVersion: { type: 'string', default: '1.0' },
                retryCount: { type: 'integer', default: 0 },
                dlqReason: { type: 'string' }
              },
              required: ['correlationId', 'schemaVersion']
            },
            payload: {
              type: 'object',
              properties: {
                eventId: { type: 'string', format: 'uuid' },
                occurredOn: { type: 'string', format: 'date-time' },
                eventType: { type: 'string' },
                payload: {
                  type: 'object',
                  properties: {
                    amount: { type: 'number' },
                    currency: { type: 'string' }
                  }
                }
              },
              required: ['eventId', 'occurredOn', 'eventType', 'payload']
            }
          }
        }
      }
    }
  };

  let tempFiles: string[] = [];

  afterEach(() => {
    tempFiles.forEach(f => cleanupFile(f));
    tempFiles = [];
  });

  it('should pass validation for a valid AsyncAPI 2.6 document', () => {
    const filePath = createTempFile(JSON.stringify(validSpec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.specVersion).toBe('2.6.0');
  });

  it('should error when asyncapi version field is missing', () => {
    const spec = { ...validSpec, asyncapi: undefined };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('"asyncapi" version field'))).toBe(true);
  });

  it('should error when info.title is missing', () => {
    const spec = { ...validSpec, info: { version: '1.0.0' } };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('info.title'))).toBe(true);
  });

  it('should error when channels object is missing', () => {
    const spec = { asyncapi: '2.6.0', info: { title: 'T', version: '1.0.0' } };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('channels'))).toBe(true);
  });

  it('should error when a channel has no publish or subscribe', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: { 'test/channel': {} }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('publish') && e.message.includes('subscribe'))).toBe(true);
  });

  it('should error when message is missing payload', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          publish: {
            message: { name: 'TestEvent' }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('payload'))).toBe(true);
  });

  it('should error on unresolved $ref', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          publish: {
            message: { $ref: '#/components/messages/NonExistent' }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.errors.some(e => e.message.includes('$ref'))).toBe(true);
  });

  it('should warn on missing correlationId in headers', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          publish: {
            message: {
              headers: { type: 'object', properties: { schemaVersion: { type: 'string' } } },
              payload: { type: 'object', properties: { data: { type: 'string' } } }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.message.includes('correlationId'))).toBe(true);
  });

  it('should warn on DLQ inconsistency (retryCount without dlqReason)', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          publish: {
            message: {
              headers: {
                type: 'object',
                properties: {
                  correlationId: { type: 'string' },
                  causationId: { type: 'string' },
                  retryCount: { type: 'integer' }
                }
              },
              payload: { type: 'object', properties: { data: { type: 'string' } } }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.warnings.some(w => w.message.includes('dlqReason'))).toBe(true);
  });

  it('should warn on missing Kafka consumerGroup', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          bindings: { kafka: {} },
          publish: {
            message: {
              payload: { type: 'object', properties: { data: { type: 'string' } } }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.warnings.some(w => w.message.includes('consumerGroup') || w.message.includes('groupId'))).toBe(true);
  });

  it('should warn on missing RabbitMQ queue when routingKey is set', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/channel': {
          bindings: { rabbitmq: { is: 'routingKey' } },
          publish: {
            message: {
              payload: { type: 'object', properties: { data: { type: 'string' } } }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.warnings.some(w => w.message.includes('routingKey') && w.message.includes('queue'))).toBe(true);
  });

  it('should pass clean with valid spec and all bindings/headers', () => {
    const filePath = createTempFile(JSON.stringify(validSpec));
    tempFiles.push(filePath);

    const result = validateAsyncAPISpec(filePath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('AsyncAPI Validator - IR Cross-Reference', () => {
  let tempFiles: string[] = [];

  afterEach(() => {
    tempFiles.forEach(f => cleanupFile(f));
    tempFiles = [];
  });

  function makeMinimalIR(events: { name: string }[]): SpecificationIR {
    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      sourceFile: 'test.feature',
      featureId: 'test',
      featureName: 'Test',
      featureDescription: [],
      tags: [],
      actors: [],
      commands: [],
      queries: [],
      events: events.map((ev, i) => ({
        id: `evt-${i}`,
        source: { file: 'test.feature', line: 1 },
        confidence: 1.0,
        inferenceSource: 'deterministic' as const,
        name: ev.name,
        eventType: ev.name,
        payload: [],
        triggeredBy: []
      })),
      fields: [
        { name: 'amount', type: 'number' as const, required: true, validations: [], exampleValues: [] },
        { name: 'currency', type: 'string' as const, required: true, validations: [], exampleValues: [] }
      ],
      scenarios: [],
      stateMachines: [],
      invariants: [],
      apiEndpoints: [],
      constraints: [],
      policies: [],
      assumptions: [],
      risks: [],
      traceability: { links: [], coverage: { specifiedRequirements: 0, implementedRequirements: 0, testedRequirements: 0, coveragePercent: 0 } },
      qualityIndicators: { scenarioCompleteness: 0, constraintCoverage: 0, missingScenarioCategories: [], ambiguities: [], contradictions: [] }
    };
  }

  it('should error when IR event has no matching AsyncAPI channel', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/events/somethingelse': {
          publish: {
            message: {
              name: 'SomethingElse',
              payload: { type: 'object', properties: {} }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const ir = makeMinimalIR([{ name: 'PaymentInitiated' }]);
    const result = validateAsyncAPIAgainstIR(filePath, ir);
    expect(result.errors.some(e => e.message.includes('PaymentInitiated'))).toBe(true);
  });

  it('should warn when IR payload field is missing from AsyncAPI', () => {
    const spec = {
      asyncapi: '2.6.0',
      info: { title: 'T', version: '1.0.0' },
      channels: {
        'test/events/paymentinitiated': {
          publish: {
            message: {
              name: 'PaymentInitiated',
              payload: {
                type: 'object',
                properties: {
                  eventId: { type: 'string' },
                  occurredOn: { type: 'string' },
                  eventType: { type: 'string' },
                  payload: {
                    type: 'object',
                    properties: {
                      amount: { type: 'number' }
                      // 'currency' missing
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    const filePath = createTempFile(JSON.stringify(spec));
    tempFiles.push(filePath);

    const ir = makeMinimalIR([{ name: 'PaymentInitiated' }]);
    const result = validateAsyncAPIAgainstIR(filePath, ir);
    expect(result.warnings.some(w => w.message.includes('currency'))).toBe(true);
  });
});
