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

  it('other clouds are a configuration error, not a half-generated stack', () => {
    expect(() => renderDeploymentTargets({ ...serviceConfig('enrollment-service'), deploy: { cloud: 'gcp', base: { dir: '../../infrastructure/base' } } })).toThrow(ConfigError);
  });
});
