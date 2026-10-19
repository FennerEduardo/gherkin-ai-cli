import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultConfig } from '../../src/core/config';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { deploymentContext, renderDeploymentGuidance, writeDeploymentContext, DEPLOYMENT_CONTEXT_MD } from '../../src/generators/deploy/context';
import { generatePrompts } from '../../src/generators/prompts';
import { validateDeploymentReadiness } from '../../src/core/validators/deployment-readiness';
import { generateInfra } from '../../src/generators/infra';

const cfg = (language: string, framework: string, extra: object = {}) =>
  ({ ...defaultConfig, projectName: 'orders', stack: { ...defaultConfig.stack, language, framework, messaging: 'rabbitmq', database: 'postgresql' }, ...extra }) as any;

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const tmp = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-deploy-ctx-')));

describe('deployment context for agents', () => {
  it('describes the runtime contract of a backend, and nothing for a frontend-only stack', () => {
    const ctx = deploymentContext(cfg('typescript', 'nestjs'))!;
    expect(ctx.image).toMatchObject({ port: 3000, liveness: '/health', readiness: '/health/ready' });
    expect(ctx.environment).toEqual(expect.arrayContaining(['DATABASE_URL', 'JWT_SECRET', 'AMQP_URL']));
    expect(ctx.deploy).toBeUndefined();
    expect(deploymentContext(cfg('dart', 'flutter'))).toBeUndefined();
  });

  it('adds the cloud target, its broker and secrets when deploy is configured', () => {
    const ctx = deploymentContext(cfg('php', 'laravel', { deploy: { cloud: 'gcp', compute: 'both' } }))!;
    expect(ctx.broker).toBe('pubsub');
    expect(ctx.environment).toEqual(expect.arrayContaining(['GHK_BROKER', 'PUBSUB_PROJECT_ID', 'APP_KEY']));
    expect(ctx.deploy).toMatchObject({ cloud: 'gcp', paths: ['deploy/terraform/gcp/', 'deploy/helm/orders/'] });
    expect(renderDeploymentGuidance(ctx, { compact: true })).toMatch(/^### Deployment Readiness\n.*Target: gcp \(both\)/);
  });

  it('writes the context files and adds the section to the agent prompts', () => {
    const d = tmp();
    const config = cfg('go', 'chi');
    expect(writeDeploymentContext(d, config)).toBeDefined();
    expect(fs.readFileSync(path.join(d, DEPLOYMENT_CONTEXT_MD), 'utf8')).toContain('## Production checklist');
    const prompts = generatePrompts(parseGherkinText('Feature: Orders\n  Scenario: Place\n    When the customer places an order\n    Then the order is placed'), config);
    expect(prompts['backend-agent.md']).toContain('## [MANDATORY] Deployment Readiness');
  });
});

describe('ghk validate: deployment readiness', () => {
  it('passes on generated output and flags secrets in the image or the deployment code', () => {
    const d = tmp();
    const config = cfg('ruby', 'rails', { deploy: { cloud: 'aws' } });
    fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM ruby:3.3-slim\nUSER app\n');
    fs.writeFileSync(path.join(d, '.env.example'), generateInfra(config).envExample);
    fs.mkdirSync(path.join(d, 'deploy/terraform/aws'), { recursive: true });
    fs.writeFileSync(path.join(d, 'deploy/terraform/aws/secrets.tf'), 'secret_string = local.secret_values[each.key]\n');
    expect(validateDeploymentReadiness(config, d)).toMatchObject({ checked: true, errors: [], warnings: [] });

    fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM ruby:3.3-slim\nENV JWT_SECRET=abc123\n');
    fs.writeFileSync(path.join(d, 'deploy/terraform/aws/db.tf'), '  password = "hunter2hunter2"\n');
    const bad = validateDeploymentReadiness(config, d);
    expect(bad.errors.some(e => e.includes('JWT_SECRET bakes a secret'))).toBe(true);
    expect(bad.errors.some(e => e.startsWith('deploy/terraform/aws/db.tf:1'))).toBe(true);
    expect(bad.warnings.some(w => w.includes('non-root USER'))).toBe(true);
  });
});
