import { describe, it, expect } from 'vitest';
import { generateNestJsCqrsModules } from '../../src/generators/nestjs/cqrs-generator';
import { generateNestJsOutboxInfrastructure } from '../../src/generators/nestjs/outbox-generator';
import { generateNestJsIdempotencyInterceptor } from '../../src/generators/nestjs/idempotency-generator';
import { generateVuePiniaStore, generateVueComposable } from '../../src/generators/frontend/vue-pinia-generator';
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
    expect(code).toContain('@prisma/client');
    expect(code).toContain('outboxMessage.create');
    expect(code).toContain('saveMessage');
  });

  it('should generate NestJS Idempotency Interceptor', () => {
    const code = generateNestJsIdempotencyInterceptor();
    expect(code).toContain('NestInterceptor');
    expect(code).toContain('x-idempotency-key');
    expect(code).toContain('processedEvent.findUnique');
  });

  it('should generate Vue Pinia Store', () => {
    const code = generateVuePiniaStore('Transactions');
    expect(code).toContain('defineStore');
    expect(code).toContain('useTransactionsStore');
    expect(code).toContain('axios.get(\'/api/transactions\')');
  });

  it('should generate Vue Composable', () => {
    const code = generateVueComposable('PaymentFlow');
    expect(code).toContain('export function usePaymentFlow');
    expect(code).toContain('onMounted');
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
  });
});

