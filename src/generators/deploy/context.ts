/* ==========================================================================
   gherkin-ai-cli - .ghe/deployment-context.{md,json}

   What an agent must respect so the code it writes stays deployable: the
   image's runtime contract (environment variables, probes, port), the broker
   selection, and, when config.deploy is set, the cloud resources and secrets
   the generated Terraform / Helm provide. Written by generate and implement;
   the implement prompt and the agent prompts point at the .md file.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../../core/config';
import { CLI_VERSION } from '../../version';
import { brokerVariables, runtimeBroker } from './broker-env';
import { renderContainerFiles } from './container';
import { cloudBroker, deployConfig, serviceSpec } from './service-spec';
import { getStackSupport } from '../stack-support';
import { resolveAppRuntimeEnv, resolveHealth } from '../toolchains';

export const DEPLOYMENT_CONTEXT_MD = '.ghe/deployment-context.md';
export const DEPLOYMENT_CONTEXT_JSON = '.ghe/deployment-context.json';

export interface DeploymentContext {
  generatedBy: string;
  stack: string;
  image: { dockerfile: boolean; port: number; liveness: string; readiness: string };
  /** Environment variables the service reads (never hardcode their values). */
  environment: string[];
  broker: string;
  deploy?: { cloud: string; compute: string; environments: string[]; paths: string[]; secrets: string[] };
  rules: string[];
  checklist: string[];
}

const FRAMEWORK_SECRETS: Record<string, string[]> = { 'php/laravel': ['APP_KEY'], 'ruby/rails': ['SECRET_KEY_BASE'], 'python/django': ['DJANGO_SECRET_KEY', 'DJANGO_ALLOWED_HOSTS'] };

/** Framework settings the production image needs besides the runtime contract (secret manager in a deployment). */
export function frameworkVariables(config: Pick<GherkinAIConfig, 'stack'>): string[] {
  const id = getStackSupport(config as GherkinAIConfig).id;
  return FRAMEWORK_SECRETS[id] ?? (id.startsWith('elixir/phoenix') ? ['SECRET_KEY_BASE'] : []);
}

/** Variables .env.example must document: the runtime contract with the local broker, and the framework settings. */
export function requiredLocalVariables(config: GherkinAIConfig): string[] {
  return ['DATABASE_URL', 'JWT_SECRET', ...brokerVariables(config), ...frameworkVariables(config)];
}

/** The context of a backend with a production image; undefined for frontend-only or experimental stacks. */
export function deploymentContext(config: GherkinAIConfig): DeploymentContext | undefined {
  if (!renderContainerFiles(config).length) return undefined;
  const support = getStackSupport(config);
  const { port } = resolveAppRuntimeEnv(config);
  const health = resolveHealth(config);
  const deploy = deployConfig(config);
  const broker = deploy ? cloudBroker(config, deploy.cloud) : runtimeBroker(config);
  const frameworkSecrets = frameworkVariables(config);
  const environment = [...new Set(['DATABASE_URL', 'JWT_SECRET', ...brokerVariables({ stack: { ...config.stack, messaging: broker } }), ...frameworkSecrets, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME'])];
  const spec = deploy ? serviceSpec(config, deploy.cloud) : undefined;
  const deployPaths = deploy ? [
    ...(deploy.compute !== 'kubernetes' ? [`deploy/terraform/${deploy.cloud}/`] : []),
    ...(deploy.compute !== 'containers' && spec ? [`deploy/helm/${spec.name}/`] : [])
  ] : [];

  const rules = [
    'Read configuration only from environment variables (the list above); never hardcode hosts, URLs, credentials, tokens or keys, and never commit .env files.',
    'A new setting is a new environment variable: add it to .env.example and to the deployment code (Terraform variables / Helm values), which a human approves.',
    `Keep the probes working: liveness ${health.live} must not depend on external systems; readiness ${health.ready} answers 200 only when the service can serve traffic.`,
    'Publish domain events only through the transactional outbox (runtime CommandService); never call the broker from domain or HTTP code. The broker is chosen at start-up (GHK_BROKER).',
    'Log to stdout/stderr (structured, no secrets or personal data) and keep no state on the container filesystem: instances are replaced at any time.',
    'Handle SIGTERM: stop taking work, finish in-flight requests, then exit (rolling deployments and scale-in send it).',
    'Database changes must be backward compatible with the previous release (expand, then contract): both versions run side by side during a deployment.',
    'Do not change Dockerfile, .dockerignore or deploy/** without human approval (agent firewall); the image must stay multi-stage and non-root.'
  ];
  const checklist = [
    'docker build succeeds and the container starts with only the environment variables above',
    `GET ${health.live} and GET ${health.ready} answer 200 on port ${port}`,
    'no secret or environment-specific value in the code, the image or the repository',
    '.env.example lists every variable the code reads',
    'new outbound dependencies (APIs, queues, buckets) are declared in the deployment code with least-privilege access',
    ...(deploy ? [`terraform validate / helm lint pass for ${deploy.environments.join(', ')}`] : [])
  ];

  return {
    generatedBy: `gherkin-ai ${CLI_VERSION}`,
    stack: support.label,
    image: { dockerfile: true, port, liveness: health.live, readiness: health.ready },
    environment,
    broker,
    ...(deploy && spec ? {
      deploy: { cloud: deploy.cloud, compute: deploy.compute, environments: deploy.environments, paths: deployPaths, secrets: spec.secrets.map(s => s.name) }
    } : {}),
    rules,
    checklist
  };
}

export function renderDeploymentContextMarkdown(ctx: DeploymentContext): string {
  return `# Deployment context

> Generated by ${ctx.generatedBy}. Code that breaks these rules does not deploy: follow them in every change.

**Stack:** ${ctx.stack} · **Image:** \`Dockerfile\` (multi-stage, non-root), port ${ctx.image.port} · **Probes:** liveness \`${ctx.image.liveness}\`, readiness \`${ctx.image.readiness}\` · **Broker:** ${ctx.broker}

## Environment variables (the only configuration)
${ctx.environment.map(v => `- \`${v}\``).join('\n')}
${ctx.deploy ? `
## Target
- **Cloud:** ${ctx.deploy.cloud} (${ctx.deploy.compute}), environments: ${ctx.deploy.environments.join(', ')}
- **Deployment code:** ${ctx.deploy.paths.map(p => `\`${p}\``).join(', ')} (human approval required)
- **Secrets from the cloud secret manager:** ${ctx.deploy.secrets.map(s => `\`${s}\``).join(', ')}
` : ''}
## Rules the implementation must follow
${ctx.rules.map(r => `- ${r}`).join('\n')}

## Production checklist
${ctx.checklist.map(c => `- [ ] ${c}`).join('\n')}
`;
}

/** Prompt section (compact: one paragraph pointing at the context file). */
export function renderDeploymentGuidance(ctx: DeploymentContext, options: { compact?: boolean; contextPath?: string } = {}): string {
  const target = ctx.deploy ? ` Target: ${ctx.deploy.cloud} (${ctx.deploy.compute}).` : '';
  if (options.compact) {
    return `### Deployment Readiness\nConfig only from env (${ctx.environment.slice(0, 4).join(', ')}, ...); no hardcoded hosts/secrets; keep ${ctx.image.liveness} and ${ctx.image.readiness} working; events only via the outbox; logs to stdout; handle SIGTERM; backward-compatible migrations; Dockerfile and deploy/** need human approval.${target}${options.contextPath ? ` Details: ${options.contextPath}.` : ''}\n`;
  }
  return `### Deployment Readiness\nThe service ships as one image (port ${ctx.image.port}, probes ${ctx.image.liveness} / ${ctx.image.readiness}) configured only by environment variables: ${ctx.environment.map(v => `\`${v}\``).join(', ')}.${target}\n${ctx.rules.map(r => `- MUST: ${r}`).join('\n')}\n${options.contextPath ? `\nFull context and checklist: ${options.contextPath}\n` : ''}`;
}

/** Writes the context files; returns the context, or undefined for a stack without a production image. */
export function writeDeploymentContext(projectDir: string, config: GherkinAIConfig): DeploymentContext | undefined {
  const ctx = deploymentContext(config);
  if (!ctx) return undefined;
  fs.mkdirSync(path.join(projectDir, '.ghe'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, DEPLOYMENT_CONTEXT_MD), renderDeploymentContextMarkdown(ctx), 'utf8');
  fs.writeFileSync(path.join(projectDir, DEPLOYMENT_CONTEXT_JSON), JSON.stringify(ctx, null, 2) + '\n', 'utf8');
  return ctx;
}
