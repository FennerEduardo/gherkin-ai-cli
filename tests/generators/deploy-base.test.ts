/* ==========================================================================
   deploy.base: shared base stack (PLAN-3.2.2 X-09; LMS P-06)
   The golden terraform-aws-base validates both modules with terraform.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';
import { ConfigError } from '../../src/core/errors';

const serviceConfig = (name: string, extra: Partial<GherkinAIConfig['stack']> = {}): GherkinAIConfig => ({
  ...defaultConfig, projectName: name, outputDir: './',
  stack: { ...defaultConfig.stack, language: 'typescript', framework: 'nestjs', orm: 'prisma', messaging: 'rabbitmq', ...extra },
  deploy: { cloud: 'aws', compute: 'containers', base: { dir: '../../infrastructure/base' } }
});

describe('deploy.base (AWS)', () => {
  const cwd = process.cwd();
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-base-'));
    for (const name of ['enrollment-service', 'identity-service']) {
      fs.mkdirSync(path.join(root, 'backend', name), { recursive: true });
      fs.writeFileSync(path.join(root, 'backend', name, 'gherkin-ai.config.json'), JSON.stringify(serviceConfig(name)));
    }
    process.chdir(path.join(root, 'backend', 'enrollment-service'));
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const files = (cfg: GherkinAIConfig) => Object.fromEntries(renderDeploymentTargets(cfg).map(f => [f.filename, f.content]));

  it('the service module reads its database and broker from the base stack', () => {
    const f = files(serviceConfig('enrollment-service'));
    expect(f['deploy/terraform/aws/database.tf']).toBeUndefined();
    expect(f['deploy/terraform/aws/broker.tf']).toBeUndefined();
    expect(f['deploy/terraform/aws/base.tf']).toContain('data "terraform_remote_state" "base"');
    const secrets = f['deploy/terraform/aws/secrets.tf'];
    expect(secrets).toContain('data.terraform_remote_state.base.outputs.database_urls["enrollment-service"]');
    expect(secrets).toContain('data.terraform_remote_state.base.outputs.amqp_url');
    expect(secrets).not.toMatch(/aws_db_instance|aws_mq_broker/);
    expect(f['deploy/terraform/aws/service.tf']).toContain('data.terraform_remote_state.base.outputs.clients_security_group_id');
    const service = Object.entries(f).filter(([name]) => name.startsWith('deploy/')).map(([, content]) => content).join('\n');
    expect(service).not.toMatch(/aws_security_group\.(database|broker)/);
    expect(f['deploy/terraform/aws/environments/dev.tfvars']).toContain('base_state_key');
    expect(f['deploy/terraform/aws/environments/dev.tfvars']).not.toMatch(/db_instance_class|mq_/);
  });

  it('writes one base module for every service that shares the directory', () => {
    const f = files(serviceConfig('enrollment-service'));
    const main = f['../../infrastructure/base/aws/main.tf'];
    expect(main).toContain('"enrollment-service" = "enrollment_service"');
    expect(main).toContain('"identity-service"   = "identity_service"');
    expect(f['../../infrastructure/base/aws/database.tf']).toContain('resource "aws_db_instance" "this"');
    expect(f['../../infrastructure/base/aws/broker.tf']).toContain('resource "aws_mq_broker" "this"');
    expect(f['../../infrastructure/base/aws/outputs.tf']).toContain('output "bootstrap_sql"');
  });

  it('an unknown cloud is a configuration error, not a half-generated stack', () => {
    expect(() => renderDeploymentTargets({ ...serviceConfig('enrollment-service'), deploy: { cloud: 'oci' as any, base: { dir: '../../infrastructure/base' } } })).toThrow();
  });
});

describe('deploy.base on Google Cloud and Azure (PLAN-3.3.0 X-09b)', () => {
  const cwd = process.cwd();
  let root: string;
  const cloudConfig = (name: string, cloud: 'gcp' | 'azure', compute: 'containers' | 'vm', messaging = 'rabbitmq'): GherkinAIConfig => ({
    ...serviceConfig(name, { messaging }), deploy: { cloud, compute, base: { dir: '../../infrastructure/base' } }
  });
  const setup = (cloud: 'gcp' | 'azure', compute: 'containers' | 'vm', messaging?: string) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-base-'));
    for (const name of ['enrollment-service', 'identity-service']) {
      fs.mkdirSync(path.join(root, 'backend', name), { recursive: true });
      fs.writeFileSync(path.join(root, 'backend', name, 'gherkin-ai.config.json'), JSON.stringify(cloudConfig(name, cloud, compute, messaging)));
    }
    process.chdir(path.join(root, 'backend', 'enrollment-service'));
    return Object.fromEntries(renderDeploymentTargets(cloudConfig('enrollment-service', cloud, compute, messaging)).map(f => [f.filename, f.content]));
  };
  afterEach(() => { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });

  it.each(['containers', 'vm'] as const)('Google Cloud (%s): the service reads its DATABASE_URL from the base; the base owns one Cloud SQL instance', compute => {
    const f = setup('gcp', compute);
    expect(f['deploy/terraform/gcp/database.tf']).toBeUndefined();
    expect(f['deploy/terraform/gcp/base.tf']).toContain('backend = "gcs"');
    expect(f['deploy/terraform/gcp/secrets.tf']).toContain('data.terraform_remote_state.base.outputs.database_urls["enrollment-service"]');
    const service = Object.entries(f).filter(([n]) => n.startsWith('deploy/terraform/gcp/')).map(([, c]) => c).join('\n');
    expect(service).not.toMatch(/google_sql_|private_services|var\.db_tier|var\.db_version/);
    expect(f['deploy/terraform/gcp/environments/dev.tfvars']).toContain('base_state_prefix');
    expect(f['../../infrastructure/base/gcp/database.tf']).toContain('resource "google_sql_database_instance" "this"');
    expect(f['../../infrastructure/base/gcp/main.tf']).toContain('"identity-service"   = "identity_service"');
    expect(f['../../infrastructure/base/gcp/outputs.tf']).toContain('output "isolation_sql"');
  });

  it.each(['containers', 'vm'] as const)('Azure (%s): database and Service Bus namespace from the base; topics stay in the service', compute => {
    const f = setup('azure', compute, 'servicebus');
    expect(f['deploy/terraform/azure/database.tf']).toBeUndefined();
    expect(f['deploy/terraform/azure/base.tf']).toContain('backend = "azurerm"');
    const service = Object.entries(f).filter(([n]) => n.startsWith('deploy/terraform/azure/')).map(([, c]) => c).join('\n');
    expect(service).not.toMatch(/azurerm_postgresql_flexible_server|resource "azurerm_servicebus_namespace"|azurerm_servicebus_namespace\.this|var\.postgres_/);
    expect(f['deploy/terraform/azure/servicebus.tf']).toContain('data.terraform_remote_state.base.outputs.servicebus_namespace_id');
    expect(f['deploy/terraform/azure/servicebus.tf']).toContain('resource "azurerm_servicebus_topic" "events"');
    expect(f['../../infrastructure/base/azure/servicebus.tf']).toContain('resource "azurerm_servicebus_namespace" "this"');
    expect(f['../../infrastructure/base/azure/outputs.tf']).toMatch(/CREATE ROLE[\s\S]*REVOKE ALL ON DATABASE[\s\S]*GRANT ALL ON DATABASE/);
  });
});
