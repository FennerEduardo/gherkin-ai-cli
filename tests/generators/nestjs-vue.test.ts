import { describe, it, expect } from 'vitest';
import { generateNestJsCqrsModules } from '../../src/generators/nestjs/cqrs-generator';
import { generateNestJsOutboxInfrastructure } from '../../src/generators/nestjs/outbox-generator';
import { generateNestJsIdempotencyInterceptor } from '../../src/generators/nestjs/idempotency-generator';
import { validateVuePiniaRules } from '../../src/core/validators/vue-validator';

describe('TypeScript Ecosystem (NestJS + Vue) Generators & Validators', () => {
  it('should generate valid NestJS CQRS module', () => {
    const code = generateNestJsCqrsModules();
    expect(code).toContain('@nestjs/cqrs');
    expect(code).toContain('CreateTransactionCommand');
    expect(code).toContain('GetTransactionQuery');
  });

  it('should generate NestJS Prisma Outbox infrastructure', () => {
    const code = generateNestJsOutboxInfrastructure();
    expect(code).toContain('PrismaService');
    expect(code).toContain('outboxMessage.create');
    expect(code).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('should generate NestJS Idempotency Interceptor', () => {
    const code = generateNestJsIdempotencyInterceptor();
    expect(code).toContain('NestInterceptor');
    expect(code).toContain('x-idempotency-key');
    expect(code).toContain('processedEvent.findUnique');
  });

  it('re-claims expired idempotency keys atomically (compare-and-set), never with a blind update', () => {
    const code = generateNestJsIdempotencyInterceptor();
    const retryBlock = code.slice(code.indexOf("existing.status === 'PROCESSING' || existing.status === 'FAILED'"), code.indexOf('// New key'));
    expect(retryBlock).toContain('processedEvent.updateMany');
    expect(retryBlock).toContain('processedAt: existing.processedAt');
    expect(retryBlock).toContain('reclaimed.count !== 1');
    expect(retryBlock).not.toContain('processedEvent.update(');
  });

  it('should validate Vue files against anti-patterns', () => {
    const context = {
      rules: [],
      files: [
        {
          path: 'src/components/BadComponent.vue',
          content: 'window.globalState = { test: 1 };\nlocalStorage.setItem("test", 1);\nEventBus.$emit("update");'
        },
        {
          path: 'src/components/GoodComponent.vue',
          content: 'const store = usePiniaStore();\nstore.update();'
        }
      ]
    };

    const result = validateVuePiniaRules(context);
    expect(result.valid).toBe(false);
    expect(result.warnings.some(w => w.includes('window'))).toBe(true);
    expect(result.warnings.some(w => w.includes('localStorage'))).toBe(true);
    expect(result.errors.some(e => e.includes('EventBus'))).toBe(true);
  });
});

import { generateAwsCdkInfrastructure } from '../../src/generators/infrastructure/aws-cdk-generator';

describe('AWS CDK Infrastructure Generator', () => {
  it('should generate AWS CDK infrastructure stack', () => {
    const code = generateAwsCdkInfrastructure('payments');
    expect(code).toContain('PaymentsInfrastructureStack');
    expect(code).toContain('aws-sns');
    expect(code).toContain('aws-sqs');
    expect(code).toContain('aws-dynamodb');
    expect(code).toContain('aws-cloudwatch');
  });
});

