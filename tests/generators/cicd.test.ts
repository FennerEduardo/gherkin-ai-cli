import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { renderCiPipelines } from '../../src/generators/cicd';
import { CoreInfraPlugin } from '../../src/plugins/core-generators-plugin';

const cfg = (language: string, framework: string, extra: object = {}) =>
  ({ ...defaultConfig, projectName: 'orders', outputDir: './generated-specs', stack: { ...defaultConfig.stack, language, framework, database: 'postgresql' }, ...extra }) as any;
const one = (c: any) => renderCiPipelines(c)[0];

describe('CI/CD pipelines', () => {
  it('is opt-in: ci.provider, or GitHub Actions when deploy is set', () => {
    expect(renderCiPipelines(cfg('go', 'chi'))).toEqual([]);
    expect(one(cfg('go', 'chi', { deploy: { cloud: 'gcp' } })).filename).toBe('.github/workflows/orders.yml');
    expect(one(cfg('go', 'chi', { ci: { provider: 'gitlab' } })).filename).toBe('.gitlab-ci.yml');
    expect(one(cfg('go', 'chi', { ci: { provider: 'azure-devops' } })).filename).toBe('azure-pipelines.yml');
  });

  it('GitHub: CI in the toolchain image with the integration services, pinned CLI, ordered OIDC deployments', () => {
    const wf = one(cfg('java', 'spring-boot', { deploy: { cloud: 'aws', environments: ['dev', 'prod'] } })).content;
    expect(wf).toContain('image: maven:3.9-eclipse-temurin-17');
    expect(wf).toContain('working-directory: generated-specs');
    expect(wf).toContain('GHK_VERSION: "3.2.0"');
    expect(wf).toContain('DATABASE_URL: "postgres://postgres:ghk@postgres:5432/postgres"');
    expect(wf).toContain('mvn -B -ntp test -Pintegration');
    expect(wf).toMatch(/deploy-dev:[\s\S]*needs: \[backend, image, spec-gates\][\s\S]*deploy-prod:[\s\S]*needs: \[deploy-dev\]/);
    expect(wf).toContain('id-token: write');
    expect(wf).toContain('role-to-assume: ${{ vars.AWS_ROLE_ARN }}');
    expect(wf).toContain('-backend-config=environments/prod.s3.tfbackend');
    expect(wf).toContain('curl -fsS "$URL/health/ready"');
    expect(wf).not.toContain('@latest');
  });

  it('GitHub with Kubernetes deploys the Helm chart instead of Terraform', () => {
    const wf = one(cfg('python', 'django', { deploy: { cloud: 'azure', compute: 'kubernetes' } })).content;
    expect(wf).toContain('helm upgrade --install orders "generated-specs/deploy/helm/orders"');
    expect(wf).toContain('az aks get-credentials');
    expect(wf).not.toContain('terraform apply');
  });

  it('GitLab: no job named after a global keyword; Azure Pipelines: schema types', () => {
    const gl = one(cfg('php', 'laravel', { ci: { provider: 'gitlab' } })).content;
    for (const keyword of ['image', 'services', 'variables', 'cache', 'default', 'include']) {
      expect(gl.split('\n').filter(l => l === `${keyword}:`).length, keyword).toBeLessThanOrEqual(keyword === 'variables' ? 1 : 0);
    }
    expect(gl).toContain('build-image:');
    const az = one(cfg('csharp', 'aspnet-core', { ci: { provider: 'azure-devops' } })).content;
    expect(az).toContain("fetchDepth: '0'");
    expect(az).toContain("-e GHK_BROKER='rabbitmq'");
  });

  it('is written at the repository root when the project is generated in a subdirectory', () => {
    const artifacts = new CoreInfraPlugin().generate({} as any, cfg('go', 'chi', { ci: { provider: 'github' } }));
    expect(artifacts.map(a => a.filePath)).toContain('../.github/workflows/orders.yml');
  });
});
