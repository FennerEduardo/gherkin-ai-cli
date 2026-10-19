/* ==========================================================================
   gherkin-ai-cli - Stack support tiers

   stable:       a sample project is generated, compiled AND its generated
                 test suite run on every CI build (scripts/golden-build.js);
                 breaking changes follow semver.
   beta:         generators are unit-tested; generated projects are either not
                 built in CI (expect manual fixes) or, with a golden entry, built
                 in CI but not yet promoted to stable.
   experimental: skeletons only; may change at any time.

   Keep in sync with scripts/golden-stacks.js.
   ========================================================================== */

import type { GherkinAIConfig } from '../core/config';
import { resolveNodeProfile } from './node-profile';

export type SupportTier = 'stable' | 'beta' | 'experimental';
export type StackKind = 'backend' | 'frontend' | 'contracts' | 'infrastructure';

export interface StackSupport {
  id: string;
  label: string;
  kind: StackKind;
  tier: SupportTier;
  /** Golden build entry that verifies it (scripts/golden-stacks.js). */
  golden?: string;
  notes?: string;
}

export const STACK_SUPPORT: StackSupport[] = [
  { id: 'typescript/nestjs', label: 'TypeScript · NestJS 11 + Prisma 6 (CommonJS)', kind: 'backend', tier: 'stable', golden: 'nestjs', notes: 'Default. stack.frameworkVersion "12" and/or stack.ormVersion "7" select the newer majors.' },
  { id: 'typescript/nestjs-12', label: 'TypeScript · NestJS 12 + Prisma 7 (ES modules)', kind: 'backend', tier: 'stable', golden: 'nestjs-12', notes: 'stack.frameworkVersion "12", stack.ormVersion "7".' },
  { id: 'typescript/nestjs-12-prisma6', label: 'TypeScript · NestJS 12 + Prisma 6 (ES modules)', kind: 'backend', tier: 'stable', golden: 'nestjs-12-prisma6', notes: 'stack.frameworkVersion "12".' },
  { id: 'typescript/nestjs-prisma7', label: 'TypeScript · NestJS 11 + Prisma 7 (CommonJS)', kind: 'backend', tier: 'stable', golden: 'nestjs-prisma7', notes: 'stack.ormVersion "7".' },
  { id: 'typescript/express', label: 'TypeScript · Express 5', kind: 'backend', tier: 'stable', golden: 'express' },
  { id: 'typescript/express-prisma7', label: 'TypeScript · Express 5 + Prisma 7', kind: 'backend', tier: 'stable', golden: 'express-prisma7', notes: 'stack.ormVersion "7".' },
  { id: 'csharp/dotnet', label: 'C# · ASP.NET Core 8 + EF Core', kind: 'backend', tier: 'stable', golden: 'dotnet' },
  { id: 'java/spring', label: 'Java 17 · Spring Boot 4 (Maven)', kind: 'backend', tier: 'stable', golden: 'java' },
  { id: 'java/quarkus', label: 'Java 21 · Quarkus 3.40 LTS (Maven)', kind: 'backend', tier: 'stable', golden: 'quarkus', notes: 'Agroal + Quarkus REST over the JVM runtime kernel.' },
  { id: 'kotlin/spring', label: 'Kotlin · Spring Boot 4 (Gradle)', kind: 'backend', tier: 'stable', golden: 'kotlin', notes: 'Pattern infrastructure is shared Java code compiled alongside Kotlin.' },
  { id: 'python/fastapi', label: 'Python · FastAPI + SQLAlchemy', kind: 'backend', tier: 'stable', golden: 'fastapi' },
  { id: 'python/django', label: 'Python · Django + DRF', kind: 'backend', tier: 'stable', golden: 'django' },
  { id: 'go/chi', label: 'Go · chi', kind: 'backend', tier: 'stable', golden: 'go' },
  { id: 'php/laravel', label: 'PHP · Laravel 13', kind: 'backend', tier: 'stable', golden: 'laravel' },
  { id: 'ruby/rails', label: 'Ruby · Rails 8 (API)', kind: 'backend', tier: 'stable', golden: 'rails' },
  { id: 'elixir/phoenix', label: 'Elixir · Phoenix', kind: 'backend', tier: 'stable', golden: 'phoenix' },
  { id: 'rust/axum', label: 'Rust · Axum', kind: 'backend', tier: 'stable', golden: 'rust' },
  { id: 'dart/flutter', label: 'Dart · Flutter (standalone app)', kind: 'backend', tier: 'stable', golden: 'flutter' },

  { id: 'frontend/react', label: 'React 19 · Redux Toolkit · Vite', kind: 'frontend', tier: 'stable', golden: 'react' },
  { id: 'frontend/vue', label: 'Vue 3 · Pinia · Vite', kind: 'frontend', tier: 'stable', golden: 'vue' },
  { id: 'frontend/angular', label: 'Angular 22 · NgRx Signals', kind: 'frontend', tier: 'stable', golden: 'angular' },
  { id: 'frontend/nextjs', label: 'Next.js 16 (App Router)', kind: 'frontend', tier: 'stable', golden: 'nextjs' },
  { id: 'frontend/react-native', label: 'React Native · Expo SDK 57', kind: 'frontend', tier: 'stable', golden: 'react-native' },
  { id: 'frontend/flutter', label: 'Flutter', kind: 'frontend', tier: 'stable', golden: 'flutter-frontend' },
  { id: 'frontend/phoenix-liveview', label: 'Phoenix LiveView', kind: 'frontend', tier: 'stable', golden: 'phoenix-liveview', notes: 'Requires the Phoenix backend.' },

  { id: 'contracts/grpc', label: 'gRPC (Protobuf, buf-linted)', kind: 'contracts', tier: 'stable', golden: 'grpc-graphql', notes: 'Enable with contracts.grpc: true.' },
  { id: 'contracts/graphql', label: 'GraphQL SDL', kind: 'contracts', tier: 'stable', golden: 'grpc-graphql', notes: 'Enable with contracts.graphql: true.' },

  { id: 'messaging/gcp-pubsub', label: 'Google Cloud Pub/Sub broker (JVM runtime kernel: Spring Java/Kotlin, Quarkus)', kind: 'infrastructure', tier: 'stable', golden: 'quarkus-pubsub', notes: 'stack.messaging "pubsub" makes it the default; GHK_BROKER=pubsub selects it at run time. REST API, emulator-verified.' },
  { id: 'messaging/azure-servicebus', label: 'Azure Service Bus broker (JVM runtime kernel: Spring Java/Kotlin, Quarkus)', kind: 'infrastructure', tier: 'stable', golden: 'quarkus-servicebus', notes: 'stack.messaging "servicebus" (adds the Azure SDK); Entra ID via SERVICEBUS_NAMESPACE or a connection string. Emulator-verified.' },
  { id: 'messaging/gcp-pubsub-typescript', label: 'Google Cloud Pub/Sub broker (TypeScript runtime kernel: NestJS, Express)', kind: 'infrastructure', tier: 'stable', golden: 'nestjs-pubsub', notes: 'Same adapter contract as the JVM one; REST API, emulator-verified.' },
  { id: 'messaging/azure-servicebus-typescript', label: 'Azure Service Bus broker (TypeScript runtime kernel: NestJS, Express)', kind: 'infrastructure', tier: 'stable', golden: 'nestjs-servicebus', notes: 'stack.messaging "servicebus" adds @azure/service-bus and @azure/identity. Emulator-verified.' },
  { id: 'messaging/gcp-pubsub-dotnet', label: 'Google Cloud Pub/Sub broker (.NET runtime kernel)', kind: 'infrastructure', tier: 'stable', golden: 'dotnet-pubsub', notes: 'REST API (HttpClient), emulator-verified.' },
  { id: 'messaging/azure-servicebus-dotnet', label: 'Azure Service Bus broker (.NET runtime kernel)', kind: 'infrastructure', tier: 'stable', golden: 'dotnet-servicebus', notes: 'stack.messaging "servicebus" adds Azure.Messaging.ServiceBus and Azure.Identity. Emulator-verified.' },
  { id: 'messaging/gcp-pubsub-python', label: 'Google Cloud Pub/Sub broker (Python runtime kernel: FastAPI, Django)', kind: 'infrastructure', tier: 'stable', golden: 'fastapi-pubsub', notes: 'REST API (urllib), emulator-verified.' },
  { id: 'messaging/azure-servicebus-python', label: 'Azure Service Bus broker (Python runtime kernel: FastAPI, Django)', kind: 'infrastructure', tier: 'stable', golden: 'fastapi-servicebus', notes: 'stack.messaging "servicebus" adds azure-servicebus and azure-identity. Emulator-verified.' },
  { id: 'messaging/gcp-pubsub-go', label: 'Google Cloud Pub/Sub broker (Go runtime kernel)', kind: 'infrastructure', tier: 'stable', golden: 'go-pubsub', notes: 'REST API (net/http), emulator-verified.' },
  { id: 'messaging/azure-servicebus-go', label: 'Azure Service Bus broker (Go runtime kernel)', kind: 'infrastructure', tier: 'stable', golden: 'go-servicebus', notes: 'stack.messaging "servicebus" adds azservicebus and azidentity. Emulator-verified.' },
  { id: 'messaging/gcp-pubsub-rust', label: 'Google Cloud Pub/Sub broker (Rust runtime kernel)', kind: 'infrastructure', tier: 'stable', golden: 'rust-pubsub', notes: 'REST API (reqwest, rustls), emulator-verified. No Service Bus adapter: there is no official Azure Service Bus SDK for Rust.' },
  { id: 'messaging/gcp-pubsub-ruby', label: 'Google Cloud Pub/Sub broker (Ruby runtime kernel: Rails)', kind: 'infrastructure', tier: 'stable', golden: 'rails-pubsub', notes: 'REST API (Net::HTTP), emulator-verified. No Service Bus adapter: there is no official Azure Service Bus SDK for Ruby.' },
  { id: 'messaging/gcp-pubsub-elixir', label: 'Google Cloud Pub/Sub broker (Elixir runtime kernel: Phoenix)', kind: 'infrastructure', tier: 'stable', golden: 'phoenix-pubsub', notes: 'REST API (:httpc), emulator-verified. No Service Bus adapter: there is no official Azure Service Bus SDK for Elixir.' },
  { id: 'messaging/gcp-pubsub-php', label: 'Google Cloud Pub/Sub broker (PHP runtime kernel: Laravel)', kind: 'infrastructure', tier: 'stable', golden: 'laravel-pubsub', notes: 'REST API (curl), emulator-verified. No Service Bus adapter: there is no official Azure Service Bus SDK for PHP.' },
  { id: 'deploy/terraform-aws', label: 'Terraform for AWS (ECS Fargate + ALB, RDS PostgreSQL, Amazon MQ for RabbitMQ, Secrets Manager)', kind: 'infrastructure', tier: 'stable', golden: 'terraform-aws', notes: 'deploy.cloud "aws". Verified with terraform validate and fmt -check (never applied in CI).' },
  { id: 'deploy/terraform-gcp', label: 'Terraform for Google Cloud (Cloud Run, Cloud SQL PostgreSQL, Pub/Sub, Secret Manager)', kind: 'infrastructure', tier: 'stable', golden: 'terraform-gcp', notes: 'deploy.cloud "gcp". Verified with terraform validate and fmt -check (never applied in CI).' },
  { id: 'deploy/terraform-azure', label: 'Terraform for Azure (Container Apps, PostgreSQL Flexible Server, Service Bus, Key Vault)', kind: 'infrastructure', tier: 'stable', golden: 'terraform-azure', notes: 'deploy.cloud "azure" with stack.messaging "servicebus". Verified with terraform validate and fmt -check (never applied in CI).' },
  { id: 'deploy/terraform-azure-rabbitmq', label: 'Terraform for Azure with an external RabbitMQ (stacks without a Service Bus adapter)', kind: 'infrastructure', tier: 'stable', golden: 'terraform-azure-rabbitmq', notes: 'AMQP_URL from the amqp_url input (self-managed RabbitMQ or CloudAMQP).' },
  { id: 'deploy/helm', label: 'Helm chart for Kubernetes (EKS, GKE, AKS): probes, HPA, PDB, workload identity, outbox relay', kind: 'infrastructure', tier: 'stable', golden: 'helm', notes: 'deploy.compute "kubernetes" or "both". Verified with helm lint --strict and helm template per environment.' },
  { id: 'ci/github-actions', label: 'GitHub Actions CI/CD: spec gates, build, tests, integration, image scan and SBOM, OIDC deployment per environment', kind: 'infrastructure', tier: 'stable', golden: 'ci-github', notes: 'ci.provider "github" (default with deploy). Verified with actionlint and shellcheck.' },
  { id: 'ci/github-actions-kubernetes', label: 'GitHub Actions deployment of the Helm chart (EKS, GKE, AKS)', kind: 'infrastructure', tier: 'stable', golden: 'ci-github-kubernetes', notes: 'deploy.compute "kubernetes".' },
  { id: 'ci/gitlab', label: 'GitLab CI: spec gates, build, tests, integration, image and Trivy scan', kind: 'infrastructure', tier: 'stable', golden: 'ci-gitlab', notes: 'ci.provider "gitlab". Verified against the GitLab CI schema. Deployment: the generated Terraform / Helm with your OIDC federation.' },
  { id: 'ci/azure-pipelines', label: 'Azure Pipelines: spec gates, build, tests, integration, image, Trivy scan and SBOM', kind: 'infrastructure', tier: 'stable', golden: 'ci-azure-pipelines', notes: 'ci.provider "azure-devops". Verified against the Azure Pipelines schema. Deployment: the generated Terraform / Helm with your service connection.' },
  { id: 'infrastructure/aws-cdk', label: 'AWS CDK v2 (SNS/SQS + DLQ alarm, DynamoDB, Secrets Manager, EKS + IRSA)', kind: 'infrastructure', tier: 'stable', golden: 'aws-cdk', notes: 'Enable with infrastructure.awsCdk: true (default when messaging is sqs/sns). Verified with assertion tests and cdk synth.' }
];

const find = (id: string) => STACK_SUPPORT.find(s => s.id === id)!;
const FRONTEND_ALIASES: Record<string, string> = {
  react: 'react', vue: 'vue', angular: 'angular', nextjs: 'nextjs', next: 'nextjs', 'react-native': 'react-native', expo: 'react-native'
};

/** Spring Boot is the JVM default: an empty or `default` framework, or any `spring*` spelling, selects it. */
export function isSpringFramework(framework: string | undefined): boolean {
  const f = (framework || '').toLowerCase();
  return f === '' || f === 'default' || f.startsWith('spring');
}

/**
 * Maps a project config to its backend support entry. This id is the routing key used by
 * presets.ts, contracts.ts and toolchains.ts, so a stack is only generated when it resolves here.
 */
export function getStackSupport(config: Pick<GherkinAIConfig, 'stack'>): StackSupport {
  const lang = config.stack.language.toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();

  // Other JVM frameworks (ktor, micronaut, ...) fall through to the experimental entry
  // instead of silently generating Spring Boot code.
  if (lang === 'kotlin' && isSpringFramework(framework)) return find('kotlin/spring');
  if (lang === 'java' && isSpringFramework(framework)) return find('java/spring');
  if (lang === 'java' && framework === 'quarkus') return find('java/quarkus');
  if (lang === 'csharp' || lang === 'dotnet' || lang === '.net') return find('csharp/dotnet');
  if (lang === 'python') return framework === 'django' ? find('python/django') : find('python/fastapi');
  if (lang === 'go') return find('go/chi');
  if (lang === 'php') return find('php/laravel');
  if (lang === 'ruby') return find('ruby/rails');
  if (lang === 'elixir') return find('elixir/phoenix');
  if (lang === 'rust') return find('rust/axum');
  if (lang === 'dart' || framework === 'flutter') return find('dart/flutter');
  if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs' || framework === 'nest' || framework === 'express') {
      const profile = resolveNodeProfile(config);
      const prisma7 = profile.prisma === '7';
      if (framework === 'express') return find(prisma7 ? 'typescript/express-prisma7' : 'typescript/express');
      if (profile.nest === '12') return find(prisma7 ? 'typescript/nestjs-12' : 'typescript/nestjs-12-prisma6');
      return find(prisma7 ? 'typescript/nestjs-prisma7' : 'typescript/nestjs');
    }
    // Frontend-only project (see frontendFramework() in presets.ts).
    const frontendOnly = FRONTEND_ALIASES[framework];
    if (frontendOnly) return find(`frontend/${frontendOnly}`);
  }
  return {
    id: `${lang}/${framework || 'unknown'}`,
    label: `${lang} ${framework}`.trim(),
    kind: 'backend',
    tier: 'experimental',
    notes: 'No dedicated preset: only contracts and prompts are generated.'
  };
}

export function supportWarning(support: StackSupport): string | undefined {
  if (support.tier === 'stable') return undefined;
  const base = support.tier === 'beta'
    ? (support.golden
      ? `${support.label} support is BETA: it is built and tested in CI (golden "${support.golden}") but not yet promoted to stable.`
      : `${support.label} support is BETA: generated code is not built in CI and may need manual fixes.`)
    : `${support.label} support is EXPERIMENTAL: expect skeletons and breaking changes.`;
  return support.notes ? `${base} ${support.notes}` : base;
}
