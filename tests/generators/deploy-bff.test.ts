/* ==========================================================================
   stack.role "bff": deployment without database or broker (PLAN-3.3.0 X-06b)
   Terraform for every cloud and compute mode, Helm and CI. The goldens
   terraform-{aws,gcp,azure}-bff and helm-bff validate the output.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';
import { serviceSpec } from '../../src/generators/deploy/service-spec';
import { CoreInfraPlugin } from '../../src/plugins/core-generators-plugin';

const bff = (deploy: GherkinAIConfig['deploy'], extra: Partial<GherkinAIConfig> = {}): GherkinAIConfig => ({
  ...defaultConfig, projectName: 'web-bff', outputDir: './',
  stack: { ...defaultConfig.stack, language: 'typescript', framework: 'express', orm: 'none', role: 'bff' },
  bff: { upstreams: { payments: { url: 'http://payments:3000' }, catalog: { url: 'http://catalog:8080' } } },
  deploy, ...extra
} as GherkinAIConfig);

const DATA = /aws_db_instance|aws_mq_broker|aws_security_group" "database|google_sql_|google_pubsub_|azurerm_postgresql|azurerm_servicebus|DATABASE_URL|AMQP_URL|KAFKA_|var\.db_|var\.postgres_/;

describe('backend-for-frontend deployment (X-06b)', () => {
  it('the service spec has no database, broker or relay; the upstream URLs are inputs', () => {
    const spec = serviceSpec(bff({ cloud: 'aws' }), 'aws');
    expect(spec.stateless).toBe(true);
    expect(spec.relayCommand).toBeUndefined();
    expect(spec.secrets.map(s => [s.name, s.source])).toEqual([['PAYMENTS_URL', 'input'], ['CATALOG_URL', 'input']]);
  });

  it.each([['aws', 'containers'], ['aws', 'vm'], ['gcp', 'containers'], ['gcp', 'vm'], ['azure', 'containers'], ['azure', 'vm']] as const)('%s / %s: Terraform without data resources', (cloud, compute) => {
    const files = renderDeploymentTargets(bff({ cloud, compute }));
    const tf = files.filter(f => f.filename.startsWith(`deploy/terraform/${cloud}/`));
    expect(tf.length).toBeGreaterThan(0);
    expect(tf.some(f => f.filename.endsWith('/database.tf'))).toBe(false);
    for (const f of tf) expect(f.content, f.filename).not.toMatch(DATA);
    const vars = tf.find(f => f.filename.endsWith('/variables.tf'))!.content;
    expect(vars).toContain('variable "payments_url"');
    expect(files.find(f => f.filename === 'deploy/README.md')!.content).toContain('owns no database');
  });

  it('Helm chart without relay; CI pipeline generated', () => {
    const helm = renderDeploymentTargets(bff({ cloud: 'gcp', compute: 'kubernetes' })).map(f => f.filename);
    expect(helm.some(f => f.startsWith('deploy/helm/web-bff/'))).toBe(true);
    const artifacts = new CoreInfraPlugin().generate({} as any, bff({ cloud: 'aws' }, { ci: { provider: 'github' } } as any)).map(a => a.filePath);
    expect(artifacts).toEqual(expect.arrayContaining(['docker-compose.yml', '.env.example', 'deploy/README.md']));
    expect(artifacts.some(a => /\.github\/workflows\//.test(a))).toBe(true);
    // No runtime kernel: the pipeline starts no database or broker and runs no integration suite.
    const workflow = new CoreInfraPlugin().generate({} as any, bff({ cloud: 'aws' }, { ci: { provider: 'github' } } as any)).find(a => /\.github\/workflows\//.test(a.filePath))!.content;
    expect(workflow).not.toMatch(/test:integration|postgres:|rabbitmq:/);
  });
});
