import { describe, it, expect } from 'vitest';
import { validateVuePiniaRules } from '../../src/core/validators/vue-validator';

describe('Vue validators', () => {
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

