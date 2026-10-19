import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/core/config';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';
import { hstr } from '../../src/generators/deploy/hcl';

const cfg = (language: string, framework: string, deploy?: object, messaging = 'none') =>
  ({ ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework, messaging, database: 'postgresql' }, ...(deploy ? { deploy } : {}) }) as any;
const files = (c: any) => Object.fromEntries(renderDeploymentTargets(c).map(f => [f.filename, f.content]));

describe('deployment targets (config.deploy)', () => {
  it('generates nothing without deploy, or for a stack without a production image', () => {
    expect(renderDeploymentTargets(cfg('typescript', 'nestjs'))).toEqual([]);
    expect(renderDeploymentTargets(cfg('dart', 'flutter', { cloud: 'aws' }))).toEqual([]);
  });

  it('AWS: ECS Fargate, RDS, Amazon MQ, secrets; the runtime declares its RabbitMQ topology', () => {
    const f = files(cfg('ruby', 'rails', { cloud: 'aws' }));
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['deploy/terraform/aws/service.tf', 'deploy/terraform/aws/environments/prod.tfvars', 'deploy/terraform/aws/environments/dev.s3.tfbackend', 'deploy/README.md']));
    expect(f['deploy/terraform/aws/secrets.tf']).toContain('"DATABASE_URL", "JWT_SECRET", "AMQP_URL", "SECRET_KEY_BASE"');
    expect(f['deploy/terraform/aws/broker.tf']).toContain('engine_type                = "RabbitMQ"');
    // Rails runs its outbox relay as a separate process.
    expect(f['deploy/terraform/aws/service.tf']).toContain('resource "aws_ecs_service" "relay"');
    expect(f['deploy/terraform/aws/main.tf']).not.toContain('GHK_DECLARE_TOPOLOGY');
    expect(f['deploy/terraform/aws/service.tf']).toContain('path                = "/health"');
  });

  it('GCP: Pub/Sub topology owned by Terraform, least-privilege service account', () => {
    const f = files(cfg('php', 'laravel', { cloud: 'gcp', environments: ['dev', 'prod'] }));
    expect(f['deploy/terraform/gcp/pubsub.tf']).toContain('name       = "orders.events"');
    expect(f['deploy/terraform/gcp/pubsub.tf']).toContain('name                       = "orders.dlq"');
    expect(f['deploy/terraform/gcp/main.tf']).toContain('GHK_DECLARE_TOPOLOGY = "false"');
    expect(f['deploy/terraform/gcp/secrets.tf']).toContain('resource "random_bytes" "app_key"');
    expect(f['deploy/terraform/gcp/service.tf']).toContain('resource "google_cloud_run_v2_worker_pool" "relay"');
    expect(Object.keys(f).filter(n => n.endsWith('.tfvars'))).toEqual(['deploy/terraform/gcp/environments/dev.tfvars', 'deploy/terraform/gcp/environments/prod.tfvars']);
  });

  it('Azure: Service Bus only where the code has its adapter, otherwise an AMQP_URL input', () => {
    const go = files(cfg('go', 'chi', { cloud: 'azure' }, 'servicebus'));
    expect(go['deploy/terraform/azure/servicebus.tf']).toContain('local_auth_enabled  = false');
    expect(go['deploy/terraform/azure/main.tf']).toContain('SERVICEBUS_NAMESPACE');
    const php = files(cfg('php', 'laravel', { cloud: 'azure' }, 'servicebus'));
    expect(php['deploy/terraform/azure/servicebus.tf']).toBeUndefined();
    expect(php['deploy/terraform/azure/variables.tf']).toContain('variable "amqp_url"');
    expect(php['deploy/terraform/azure/secrets.tf']).toContain('AMQP_URL');
  });

  it('kubernetes compute renders the Helm chart instead of Terraform; both renders both', () => {
    const k8s = files(cfg('python', 'django', { cloud: 'gcp', compute: 'kubernetes' }));
    expect(Object.keys(k8s).some(n => n.startsWith('deploy/terraform'))).toBe(false);
    expect(k8s['deploy/helm/orders/values-prod.yaml']).toContain('iam.gke.io/gcp-service-account');
    expect(k8s['deploy/helm/orders/templates/relay-deployment.yaml']).toContain('outbox-relay');
    expect(k8s['deploy/helm/orders/values.yaml']).toContain('command: ["python", "manage.py", "outbox_relay"]');
    const both = files(cfg('typescript', 'nestjs', { cloud: 'azure', compute: 'both' }));
    expect(both['deploy/helm/orders/Chart.yaml']).toBeDefined();
    expect(both['deploy/terraform/azure/service.tf']).toBeDefined();
    expect(both['deploy/helm/orders/templates/relay-deployment.yaml']).toBeUndefined();
  });

  it('escapes interpolation in HCL string literals', () => {
    expect(hstr('a${b}%{c}')).toBe('"a$${b}%%{c}"');
  });
});
