import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateOpenAPISpec, validateOpenAPIAgainstIR } from '../../src/core/openapi-validator';
import { SpecificationIR } from '../../src/core/semantic-ir';

describe('OpenAPI Validator', () => {
  const testDir = path.join(process.cwd(), '.test-openapi');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('validateOpenAPISpec()', () => {
    it('should validate a correct OpenAPI JSON spec', () => {
      const specPath = path.join(testDir, 'valid.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {}
      }));
      
      const result = validateOpenAPISpec(specPath);
      expect(result.valid).toBe(true);
      expect(result.specVersion).toBe('3.0.0');
    });

    it('should validate a correct OpenAPI YAML spec', () => {
      const specPath = path.join(testDir, 'valid.yaml');
      fs.writeFileSync(specPath, `
openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths: {}
      `.trim());
      
      const result = validateOpenAPISpec(specPath);
      expect(result.valid).toBe(true);
    });

    it('should fail if openapi field is missing', () => {
      const specPath = path.join(testDir, 'invalid.json');
      fs.writeFileSync(specPath, JSON.stringify({
        info: { title: 'Test API', version: '1.0.0' },
        paths: {}
      }));
      
      const result = validateOpenAPISpec(specPath);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('version field'))).toBe(true);
    });

    it('should fail if info or paths are missing', () => {
      const specPath = path.join(testDir, 'invalid2.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0'
      }));
      
      const result = validateOpenAPISpec(specPath);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2); // info and paths
    });
  });

  describe('validateOpenAPIAgainstIR()', () => {
    const mockIR: SpecificationIR = {
      features: [],
      actors: [],
      commands: [],
      queries: [],
      domainEvents: [],
      stateMachines: [],
      invariants: [],
      apiEndpoints: [
        {
          id: 'ep-001',
          source: { file: 'test', line: 1 },
          confidence: 1,
          inferenceSource: 'deterministic',
          method: 'POST',
          path: '/users',
          operationId: 'createUser',
          requestFields: [{ name: 'email', type: 'string', required: true }],
          responseFields: [],
          httpCodes: [
            { code: '201', description: 'Created' },
            { code: '400', description: 'Bad Request' }
          ],
          authRequired: true
        }
      ],
      constraints: [],
      policies: [],
      assumptions: [],
      risks: [],
      traceability: { features: {}, scenarios: {}, links: [] }
    };

    it('should pass when OpenAPI completely matches IR', () => {
      const specPath = path.join(testDir, 'match.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/users': {
            post: {
              requestBody: { content: {} },
              responses: {
                '201': { description: 'Created' },
                '400': { description: 'Bad Request' }
              },
              security: [{ bearerAuth: [] }]
            }
          }
        }
      }));
      
      const result = validateOpenAPIAgainstIR(specPath, mockIR);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it('should report missing paths/methods', () => {
      const specPath = path.join(testDir, 'missing.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/other': {}
        }
      }));
      
      const result = validateOpenAPIAgainstIR(specPath, mockIR);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('missing from OpenAPI'))).toBe(true);
    });

    it('should report missing HTTP response codes', () => {
      const specPath = path.join(testDir, 'missing-code.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/users': {
            post: {
              requestBody: { content: {} },
              responses: {
                '201': { description: 'Created' }
                // 400 is missing
              }
            }
          }
        }
      }));
      
      const result = validateOpenAPIAgainstIR(specPath, mockIR);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('missing in OpenAPI'))).toBe(true);
    });

    it('should warn about missing security when auth is required', () => {
      const specPath = path.join(testDir, 'missing-security.json');
      fs.writeFileSync(specPath, JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0' },
        paths: {
          '/users': {
            post: {
              requestBody: { content: {} },
              responses: {
                '201': { description: 'Created' },
                '400': { description: 'Bad Request' }
              }
              // Missing security
            }
          }
        }
      }));
      
      const result = validateOpenAPIAgainstIR(specPath, mockIR);
      expect(result.valid).toBe(true); // Warnings don't fail validation
      expect(result.warnings.some(w => w.message.includes('requires auth in IR, but no security scheme'))).toBe(true);
    });
  });
});
