import { describe, it, expect } from 'vitest';
import { generateAwsCdkApp, generateAwsCdkInfrastructure } from '../../src/generators/infrastructure/aws-cdk-generator';
import { CoreInfraPlugin, awsCdkEnabled } from '../../src/plugins/core-generators-plugin';
import { defaultConfig } from '../../src/core/config';

const cfg = (extra: Record<string, unknown> = {}, messaging = 'rabbitmq') =>
  ({ ...defaultConfig, projectName: 'order-service', stack: { ...defaultConfig.stack, messaging }, ...extra }) as any;

describe('AWS CDK app', () => {
  it('generates a complete, runnable app: bin entry, stack, cdk.json, tsconfig and assertion tests', () => {
    const files = new Map(generateAwsCdkApp('order-service').map(f => [f.filename, f.content]));
    expect([...files.keys()].sort()).toEqual([
      'infrastructure/bin/app.ts',
      'infrastructure/cdk.json',
      'infrastructure/lib/order-service-stack.ts',
      'infrastructure/package.json',
      'infrastructure/test/stack.test.ts',
      'infrastructure/tsconfig.json'
    ]);
    // cdk.json points at an entry point that exists.
    expect(JSON.parse(files.get('infrastructure/cdk.json')!).app).toBe('npx tsx bin/app.ts');
    expect(files.get('infrastructure/bin/app.ts')).toContain("from '../lib/order-service-stack'");
    const pkg = JSON.parse(files.get('infrastructure/package.json')!);
    expect(pkg.dependencies['aws-cdk-lib']).toBe('^2.272.0');
    expect(pkg.scripts).toMatchObject({ test: expect.stringContaining('--test'), synth: 'cdk synth --quiet' });
  });

  it('grants least privilege through an IRSA service account and alarms on the DLQ', () => {
    const stack = generateAwsCdkInfrastructure('order-service');
    expect(stack).toContain('export class OrderServiceInfrastructureStack extends cdk.Stack');
    expect(stack).toContain('cluster.addServiceAccount(');
    expect(stack).toContain('grantPublish(serviceAccount)');
    expect(stack).toContain('new cloudwatch.Alarm(');
    expect(stack).toContain('kubectlLayer: new KubectlV35Layer(');
  });

  it('is opt-in, and on by default only when messaging targets SQS/SNS', () => {
    expect(awsCdkEnabled(cfg())).toBe(false);
    expect(awsCdkEnabled(cfg({}, 'sqs'))).toBe(true);
    expect(awsCdkEnabled(cfg({ infrastructure: { awsCdk: true } }))).toBe(true);
    expect(awsCdkEnabled(cfg({ infrastructure: { awsCdk: false } }, 'sqs'))).toBe(false);
    const paths = (c: any) => new CoreInfraPlugin().generate({} as any, c).map(a => a.filePath);
    expect(paths(cfg()).some(p => p.startsWith('infrastructure/'))).toBe(false);
    expect(paths(cfg({ infrastructure: { awsCdk: true } }))).toContain('infrastructure/bin/app.ts');
  });
});
