/* ==========================================================================
   gherkin-ai-cli - What a CI/CD pipeline needs to know about the project

   Shared by the GitHub Actions, GitLab CI and Azure Pipelines renderers:
   where the generated code lives, the stack's toolchain (image, build, test,
   integration commands), the frontend, the services of the integration
   suite and the deployment target (config.deploy).
   ========================================================================== */

import path from 'path';
import type { GherkinAIConfig } from '../../core/config';
import { CLI_VERSION } from '../../version';
import { toKebab } from '../../utils/naming';
import { renderContainerFiles } from '../deploy/container';
import { deployConfig, DeployConfig, serviceSpec, ServiceSpec } from '../deploy/service-spec';
import { resolveHealth, resolveToolchain, Toolchain } from '../toolchains';

export type CiProvider = 'github' | 'gitlab' | 'azure-devops';

export interface PipelineSpec {
  provider: CiProvider;
  name: string;
  /** Directory of the generated project, relative to the repository root ("." when generated at the root). */
  workdir: string;
  ghkVersion: string;
  backend?: Toolchain;
  /** Production Dockerfile in workdir. */
  image: boolean;
  frontend?: { dir: string };
  deploy?: DeployConfig;
  service?: ServiceSpec;
  health: { live: string; ready: string };
}

/** Integration suite services: PostgreSQL and RabbitMQ (every runtime has the RabbitMQ adapter). */
export const CI_SERVICES = {
  postgres: { image: 'postgres:17-alpine', env: { POSTGRES_PASSWORD: 'ghk' } },
  rabbitmq: { image: 'rabbitmq:4-alpine', env: { RABBITMQ_DEFAULT_USER: 'ghk', RABBITMQ_DEFAULT_PASS: 'ghk' } }
} as const;

/** Variables of the integration step (the RabbitMQ adapter whatever stack.messaging says). */
export const CI_INTEGRATION_ENV = (host: { postgres: string; rabbitmq: string }) => ({
  DATABASE_URL: `postgres://postgres:ghk@${host.postgres}:5432/postgres`,
  AMQP_URL: `amqp://ghk:ghk@${host.rabbitmq}:5672`,
  GHK_BROKER: 'rabbitmq'
});

/** Trivy (dependency and image scan, CycloneDX SBOM). */
export const TRIVY_IMAGE = 'aquasec/trivy:0.76.0';
/** Docker CLI and daemon of the GitLab image job. */
export const DOCKER_IMAGE = 'docker:29.9';

/** Pinned majors of the GitHub Actions the workflows use. */
export const GITHUB_ACTIONS = {
  checkout: 'actions/checkout@v7',
  setupNode: 'actions/setup-node@v7',
  uploadArtifact: 'actions/upload-artifact@v7',
  trivy: 'aquasecurity/trivy-action@0.36.0',
  awsCredentials: 'aws-actions/configure-aws-credentials@v6',
  ecrLogin: 'aws-actions/amazon-ecr-login@v2',
  gcpAuth: 'google-github-actions/auth@v3',
  setupGcloud: 'google-github-actions/setup-gcloud@v3',
  gkeCredentials: 'google-github-actions/get-gke-credentials@v3',
  azureLogin: 'azure/login@v3',
  setupHelm: 'azure/setup-helm@v5',
  setupTerraform: 'hashicorp/setup-terraform@v4'
} as const;

export function ciProvider(config: GherkinAIConfig): CiProvider | undefined {
  if (config.ci?.provider) return config.ci.provider;
  // A deployment target implies a pipeline that deploys it.
  return config.deploy?.cloud ? 'github' : undefined;
}

export function pipelineSpec(config: GherkinAIConfig, provider: CiProvider): PipelineSpec {
  const out = path.posix.normalize((config.outputDir || '.').replace(/\\/g, '/')).replace(/^\.\/?/, '').replace(/\/$/, '') || '.';
  const deploy = deployConfig(config);
  const fe = config.frontendStack?.framework && config.frontendStack.framework !== 'none';
  const backend = resolveToolchain(config);
  return {
    provider,
    name: toKebab(config.projectName || 'service'),
    workdir: out,
    ghkVersion: CLI_VERSION,
    backend,
    image: renderContainerFiles(config).length > 0,
    frontend: fe ? { dir: out === '.' ? 'frontend' : `${out}/frontend` } : undefined,
    deploy,
    service: deploy ? serviceSpec(config, deploy.cloud) : undefined,
    health: resolveHealth(config)
  };
}

/** Repository-root path of a file inside the generated project. */
export const inWorkdir = (spec: PipelineSpec, file: string) => (spec.workdir === '.' ? file : `${spec.workdir}/${file}`);
