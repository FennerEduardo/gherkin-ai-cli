import { describe, it, expect } from 'vitest';
import { generateAwsCdkInfrastructure } from '../../src/generators/infrastructure/aws-cdk-generator';
import path from 'path';

describe('AWS CDK Generator', () => {
  it('should generate valid CDK stack including IRSA and SecretsManager', () => {
    const stack = generateAwsCdkInfrastructure('my-microservice');
    expect(stack).toContain('MicroserviceExecutionRole');
    expect(stack).toContain('DbCredentialsSecret');
    expect(stack).toContain('grantPublish(serviceAccountRole)');
  });

  it('should compile the generated CDK code successfully without syntax anomalies', () => {
    const cdkCode = generateAwsCdkInfrastructure('test-project');
    
    // Ensure the code isn't emitting any malformed escape characters or undefined templates
    expect(cdkCode).toContain('export class TestProjectInfrastructureStack extends cdk.Stack');
    expect(cdkCode).toContain("secretName: `${id}-db-credentials`,");
    expect(cdkCode.endsWith('}\n')).toBe(true);
  });
});
