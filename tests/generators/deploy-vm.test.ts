/* ==========================================================================
   deploy.compute "vm" (PLAN-3.2.2 X-08; LMS P-04)

   The goldens terraform-aws-vm, terraform-gcp-vm and terraform-azure-vm run
   terraform init / validate / fmt -check on the generated modules.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { defaultConfig, GherkinAIConfig } from '../../src/core/config';
import { renderDeploymentTargets } from '../../src/generators/deploy/targets';

const config = (cloud: 'aws' | 'gcp' | 'azure', stack: Partial<GherkinAIConfig['stack']> = {}): GherkinAIConfig => ({
  ...defaultConfig, projectName: 'shop', outputDir: './',
  stack: { ...defaultConfig.stack, language: 'ruby', framework: 'rails', orm: 'none', ...stack },
  deploy: { cloud, compute: 'vm' }
});

const files = (cfg: GherkinAIConfig) => Object.fromEntries(renderDeploymentTargets(cfg).map(f => [f.filename, f.content]));

describe('deploy.compute "vm"', () => {
  it('AWS: one EC2 instance next to the same RDS, Amazon MQ and Secrets Manager', () => {
    const f = files(config('aws'));
    const all = Object.values(f).join('\n');
    expect(all).toContain('resource "aws_instance" "app"');
    expect(all).toContain('resource "aws_db_instance" "this"');
    expect(all).toContain('resource "aws_mq_broker" "this"');
    expect(all).toContain('resource "aws_secretsmanager_secret" "this"');
    expect(all).not.toMatch(/aws_ecs_|aws_lb|aws_appautoscaling/);
    expect(f['deploy/terraform/aws/variables.tf']).not.toMatch(/variable "(desired_count|certificate_arn|cpu)"/);
    expect(f['deploy/terraform/aws/variables.tf']).toContain('variable "domain"');
    expect(f['deploy/terraform/aws/vm-init.sh.tftpl']).toContain('"bin/rails" "outbox:relay"');
    expect(Object.keys(f).some(n => n.includes('/helm/'))).toBe(false);
    expect(f['deploy/README.md']).toContain('one EC2 instance');
  });

  it('GCP: a Compute Engine VM with the service account, no Cloud Run', () => {
    const all = Object.values(files(config('gcp'))).join('\n');
    expect(all).toContain('resource "google_compute_instance" "app"');
    expect(all).toContain('email  = google_service_account.service.email');
    expect(all).not.toContain('google_cloud_run_v2');
  });

  it('Azure: a Linux VM with the user-assigned identity, no Container Apps', () => {
    const all = Object.values(files(config('azure', { language: 'typescript', framework: 'nestjs', messaging: 'servicebus' }))).join('\n');
    expect(all).toContain('resource "azurerm_linux_virtual_machine" "app"');
    expect(all).toContain('identity_ids = [azurerm_user_assigned_identity.app.id]');
    expect(all).not.toContain('azurerm_container_app');
  });

  it('secrets are read at boot with the machine identity, never put in the user data', () => {
    const tpl = files(config('aws'))['deploy/terraform/aws/vm-init.sh.tftpl'];
    expect(tpl).toContain('aws secretsmanager get-secret-value');
    const service = files(config('aws'))['deploy/terraform/aws/service.tf'];
    expect(service).toContain('secret_names      = join(" ", local.secret_names)');
    expect(service).not.toContain('secret_values');
  });
});
