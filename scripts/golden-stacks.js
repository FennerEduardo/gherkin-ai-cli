/* ==========================================================================
   Golden build registry: one entry per STABLE stack.
   - stack / frontendStack: the gherkin-ai.config.json used to generate
   - image: official toolchain image the project is built and tested in
   - build / test: shell commands run in the project root inside the image
   - caches: [volume-suffix, container-path] dependency caches
   Keep in sync with src/generators/stack-support.ts.
   ========================================================================== */

'use strict';

const base = { database: 'postgresql', auth: 'jwt', messaging: 'none' };

// Broker recipes shared with `ghk verify --services` (src/core/services.ts; run `npm run build` first).
const { PUBSUB_EMULATOR, KAFKA_BROKER: KAFKA, serviceBusEmulator: SERVICEBUS_EMULATOR } = require('../dist/core/services');

function nestGolden(stack = {}) {
  return {
    stack: { ...base, language: 'typescript', framework: 'nestjs', orm: 'prisma', validation: 'zod', messaging: 'rabbitmq', testing: 'jest', ...stack },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test', `node -e "import('./dist/src/app.module.js').then(m => { if (!m.AppModule) process.exit(1); })"`],
    integration: ['npm run test:integration']
  };
}

// Frontends are generated next to a backend and built/tested in ./frontend.
const feBackend = { ...base, language: 'typescript', framework: 'express', orm: 'none', validation: 'zod', testing: 'jest' };
const nodeFrontend = (framework, extra = {}) => ({
  stack: feBackend,
  frontendStack: { framework, language: 'typescript', ...extra },
  image: 'node:24-bookworm',
  workdir: 'frontend',
  caches: [['npm', '/root/.npm']],
  build: ['npm install --no-audit --no-fund --loglevel=error', 'npm run build'],
  test: ['npm test']
});

const STACKS = {
  react: nodeFrontend('react'),
  vue: nodeFrontend('vue'),
  angular: nodeFrontend('angular', { stateManagement: 'signals' }),
  nextjs: { ...nodeFrontend('nextjs'), env: { NEXT_TELEMETRY_DISABLED: '1' } },
  'react-native': { ...nodeFrontend('react-native'), env: { EXPO_NO_TELEMETRY: '1', CI: '1' } },
  flutter: {
    stack: { ...base, language: 'dart', framework: 'flutter', orm: 'none', validation: 'none', testing: 'flutter-test' },
    image: 'ghcr.io/cirruslabs/flutter:stable',
    caches: [['pub', '/root/.pub-cache']],
    build: ['flutter pub get', 'flutter analyze --no-fatal-infos'],
    test: ['flutter test']
  },
  'flutter-frontend': {
    stack: feBackend,
    frontendStack: { framework: 'flutter', language: 'dart' },
    image: 'ghcr.io/cirruslabs/flutter:stable',
    workdir: 'frontend',
    caches: [['pub', '/root/.pub-cache']],
    build: ['flutter pub get', 'flutter analyze --no-fatal-infos'],
    test: ['flutter test']
  },
  // NestJS / Prisma majors (stack.frameworkVersion / stack.ormVersion, see src/generators/node-profile.ts).
  // Each also imports the compiled AppModule, which catches module-resolution errors tsc cannot see.
  nestjs: nestGolden(),
  'nestjs-12': nestGolden({ frameworkVersion: '12', ormVersion: '7' }),
  'nestjs-12-prisma6': nestGolden({ frameworkVersion: '12' }),
  'nestjs-prisma7': nestGolden({ ormVersion: '7', database: 'mysql' }),
  // NestJS with the native cloud brokers (TypeScript runtime adapters, verified against the official emulators).
  'nestjs-pubsub': { ...nestGolden({ messaging: 'pubsub' }), services: [PUBSUB_EMULATOR] },
  'nestjs-servicebus': { ...nestGolden({ messaging: 'servicebus' }), services: SERVICEBUS_EMULATOR('golden-nestjs-servicebus') },
  'grpc-graphql': {
    stack: { ...base, language: 'typescript', framework: 'nestjs', orm: 'prisma', validation: 'zod', testing: 'jest' },
    config: { contracts: { grpc: true, graphql: true } },
    image: 'node:24-bookworm',
    workdir: 'contracts',
    caches: [['npm', '/root/.npm']],
    build: ['npx --yes @bufbuild/buf@1 build', 'npx --yes @bufbuild/buf@1 lint'],
    test: ['npm install --no-save --no-audit --no-fund --loglevel=error graphql@16', 'node validate-graphql.cjs']
  },
  // AWS CDK app (infrastructure.awsCdk): assertion tests + cdk synth, offline (no AWS account needed).
  'aws-cdk': {
    stack: feBackend,
    config: { infrastructure: { awsCdk: true } },
    image: 'node:24-bookworm',
    workdir: 'infrastructure',
    caches: [['npm', '/root/.npm']],
    env: { CDK_DISABLE_VERSION_CHECK: 'true', CDK_DISABLE_CLI_TELEMETRY: 'true' },
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npm run build'],
    test: ['npm test', 'npx cdk synth --quiet']
  },
  express: {
    stack: { ...base, language: 'typescript', framework: 'express', orm: 'prisma', validation: 'zod', testing: 'jest' },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test'],
    integration: ['npm run test:integration']
  },
  'express-prisma7': {
    stack: { ...base, language: 'typescript', framework: 'express', orm: 'prisma', ormVersion: '7', validation: 'zod', testing: 'jest' },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test'],
    integration: ['npm run test:integration']
  },
  dotnet: {
    stack: { ...base, language: 'csharp', framework: 'dotnet-aspnetcore', orm: 'efcore', validation: 'fluentvalidation', messaging: 'rabbitmq', testing: 'xunit' },
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    caches: [['nuget', '/root/.nuget/packages']],
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    // The test project references the app project, so this builds both.
    build: ['dotnet build tests/*/*.Tests.csproj -nologo -v q'],
    // Testcontainers tests need a Docker socket and run outside the golden build; the runtime
    // integration tests (Category=Integration) run against the golden PostgreSQL and RabbitMQ.
    test: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category!=Integration&Category!=Testcontainers"'],
    integration: ['dotnet test tests/*/*.Tests.csproj -nologo --no-build --filter "Category=Integration" --logger "console;verbosity=normal"']
  },
  java: {
    stack: { ...base, language: 'java', framework: 'spring-boot', orm: 'hibernate', validation: 'jakarta-validation', testing: 'junit' },
    image: 'maven:3.9-eclipse-temurin-17',
    caches: [['m2', '/root/.m2']],
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration']
  },
  quarkus: {
    stack: { ...base, language: 'java', framework: 'quarkus', orm: 'jdbc', validation: 'jakarta-validation', testing: 'junit' },
    image: 'maven:3.9-eclipse-temurin-21',
    caches: [['m2', '/root/.m2']],
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration']
  },
  // The same Quarkus service with Google Cloud Pub/Sub as the broker (official emulator; REST adapter in the JVM runtime).
  'quarkus-pubsub': {
    stack: { ...base, language: 'java', framework: 'quarkus', orm: 'jdbc', validation: 'jakarta-validation', testing: 'junit', messaging: 'pubsub' },
    image: 'maven:3.9-eclipse-temurin-21',
    caches: [['m2', '/root/.m2']],
    services: [PUBSUB_EMULATOR],
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration']
  },
  // The same Quarkus service with Azure Service Bus (official SDK; emulator + SQL Edge, fixed entities).
  'quarkus-servicebus': {
    stack: { ...base, language: 'java', framework: 'quarkus', orm: 'jdbc', validation: 'jakarta-validation', testing: 'junit', messaging: 'servicebus' },
    image: 'maven:3.9-eclipse-temurin-21',
    caches: [['m2', '/root/.m2']],
    services: SERVICEBUS_EMULATOR('golden-quarkus-servicebus'),
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration']
  },
  kotlin: {
    stack: { ...base, language: 'kotlin', framework: 'spring-boot', orm: 'hibernate', validation: 'jakarta-validation', testing: 'junit' },
    image: 'gradle:8.14-jdk17',
    caches: [['gradle', '/cache/gradle']],
    env: { GRADLE_USER_HOME: '/cache/gradle' },
    build: ['gradle -q --no-daemon assemble'],
    test: ['gradle --no-daemon test'],
    integration: ['gradle --no-daemon integrationTest']
  },
  // Kotlin domain kernel + Java runtime kernel + Quarkus application layer, built with the Quarkus Gradle plugin.
  'kotlin-quarkus': {
    stack: { ...base, language: 'kotlin', framework: 'quarkus', orm: 'jdbc', validation: 'jakarta-validation', testing: 'junit' },
    image: 'gradle:8.14-jdk21',
    caches: [['gradle', '/cache/gradle']],
    env: { GRADLE_USER_HOME: '/cache/gradle' },
    build: ['gradle -q --no-daemon assemble'],
    test: ['gradle --no-daemon test'],
    integration: ['gradle --no-daemon integrationTest']
  },
  fastapi: {
    stack: { ...base, language: 'python', framework: 'fastapi', orm: 'sqlalchemy', validation: 'pydantic', testing: 'pytest' },
    image: 'python:3.12-slim',
    caches: [['pip', '/root/.cache/pip']],
    env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    build: ['pip install -q -e ".[test]"', 'python -m compileall -q app'],
    test: ['pytest -q -rs -m "not integration"'],
    integration: ['pytest -q -rs -m integration']
  },
  django: {
    stack: { ...base, language: 'python', framework: 'django', orm: 'django-orm', validation: 'drf', testing: 'pytest' },
    image: 'python:3.12-slim',
    caches: [['pip', '/root/.cache/pip']],
    env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    build: ['pip install -q -e ".[test]"', 'python -m compileall -q app config', 'python manage.py check'],
    test: ['pytest -q -rs -m "not integration"'],
    integration: ['pytest -q -rs -m integration']
  },
  go: {
    stack: { ...base, language: 'go', framework: 'chi', orm: 'pgx', validation: 'go-playground', testing: 'testing' },
    image: 'golang:1.26',
    caches: [['gomod', '/go/pkg/mod'], ['gobuild', '/root/.cache/go-build']],
    build: ['go mod tidy', 'go vet ./...', 'go vet -tags integration ./internal/runtime/...', 'go build ./...'],
    test: ['go test ./...'],
    integration: ['go test -tags integration -count=1 -v ./internal/runtime/...']
  },
  rails: {
    stack: { ...base, language: 'ruby', framework: 'rails', orm: 'none', validation: 'active-model', testing: 'rspec' },
    image: 'ruby:3.3',
    caches: [['gems', '/usr/local/bundle']],
    env: { RAILS_ENV: 'test' },
    build: ['bundle install --quiet --jobs 4', 'ruby -c config/application.rb > /dev/null', 'bin/rails runner "puts Rails.version" > /dev/null'],
    test: ['bundle exec rspec --tag ~integration', 'bundle exec cucumber'],
    integration: ['bundle exec rspec --tag integration']
  },
  phoenix: {
    stack: { ...base, language: 'elixir', framework: 'phoenix', orm: 'none', validation: 'ecto-changeset', testing: 'exunit' },
    image: 'elixir:1.17',
    caches: [['mix', '/root/.mix'], ['hex', '/root/.hex']],
    env: { MIX_ENV: 'test' },
    build: ['mix local.hex --force --if-missing > /dev/null', 'mix local.rebar --force --if-missing > /dev/null', 'mix deps.get > /dev/null', 'mix compile --warnings-as-errors'],
    test: ['mix test'],
    integration: ['mix test --only integration']
  },
  rust: {
    stack: { ...base, language: 'rust', framework: 'axum', orm: 'none', validation: 'serde', testing: 'cargo-test' },
    image: 'rust:1.99',
    caches: [['cargo-registry', '/usr/local/cargo/registry'], ['cargo-git', '/usr/local/cargo/git']],
    // Link inside the container: test binaries written through the Docker Desktop bind mount (/work) came out
    // corrupted now and then (SIGSEGV, "Inconsistency detected by ld.so").
    env: { CARGO_TARGET_DIR: '/tmp/cargo-target' },
    build: ['cargo build --all-targets --quiet'],
    test: ['cargo test --quiet'],
    integration: ['cargo test --quiet --features integration --test runtime_integration --test http_integration -- --test-threads=1']
  },
  'phoenix-liveview': {
    stack: { ...base, language: 'elixir', framework: 'phoenix', orm: 'none', validation: 'ecto-changeset', testing: 'exunit' },
    frontendStack: { framework: 'phoenix-liveview', language: 'elixir' },
    image: 'elixir:1.17',
    caches: [['mix', '/root/.mix'], ['hex', '/root/.hex']],
    env: { MIX_ENV: 'test' },
    build: ['mix local.hex --force --if-missing > /dev/null', 'mix local.rebar --force --if-missing > /dev/null', 'mix deps.get > /dev/null', 'mix compile --warnings-as-errors'],
    test: ['mix test'],
    integration: ['mix test --only integration']
  },
  laravel: {
    stack: { ...base, language: 'php', framework: 'laravel', orm: 'eloquent', validation: 'laravel-validation', testing: 'phpunit' },
    image: 'composer:2',
    caches: [['composer', '/tmp/composer-cache']],
    env: { COMPOSER_CACHE_DIR: '/tmp/composer-cache', COMPOSER_NO_INTERACTION: '1' },
    build: [
      // pdo_pgsql and sockets for the runtime kernel (docs/RUNTIME-KERNEL.md).
      'apk add --no-cache $PHPIZE_DEPS postgresql-dev linux-headers > /dev/null && docker-php-ext-install pdo_pgsql sockets > /dev/null',
      'composer install --no-progress --prefer-dist -q',
      'find app routes tests features contracts bootstrap -name "*.php" -print0 | xargs -0 -n1 php -l > /dev/null',
      'php artisan --version'
    ],
    test: ['vendor/bin/phpunit --exclude-group integration', 'vendor/bin/behat --no-colors --format=progress'],
    integration: ['vendor/bin/phpunit --group integration']
  }
};

/** A golden backend run against a native cloud broker emulator instead of RabbitMQ (same build and tests). */
function withBroker(name, messaging) {
  const def = STACKS[name];
  const project = `golden-${name}-${messaging}`;
  return {
    ...def,
    stack: { ...def.stack, messaging },
    services: messaging === 'servicebus' ? SERVICEBUS_EMULATOR(project) : messaging === 'kafka' ? [KAFKA] : [PUBSUB_EMULATOR]
  };
}

// Service Bus only where an official SDK exists (no Rust, Ruby, Elixir or PHP SDK: RabbitMQ / CloudAMQP on Azure).
// Kafka where the runtime has an adapter (KAFKA_LANGUAGES of src/generators/deploy/broker-env.ts).
const NATIVE_BROKERS = { java: ['kafka'], quarkus: ['kafka'], nestjs: ['kafka'], dotnet: ['pubsub', 'servicebus', 'kafka'], fastapi: ['pubsub', 'servicebus', 'kafka'], go: ['pubsub', 'servicebus', 'kafka'], rust: ['pubsub'], rails: ['pubsub'], phoenix: ['pubsub'], laravel: ['pubsub'] };
for (const [name, brokers] of Object.entries(NATIVE_BROKERS)) {
  for (const messaging of brokers) STACKS[`${name}-${messaging}`] = withBroker(name, messaging);
}

// Deployment targets (config.deploy): the generated Terraform must init, validate and be fmt-clean, and the Helm chart
// must lint and render for every environment. Nothing is applied. Stacks are chosen to cover the variants: a
// separate relay process (Rails, Laravel, Django), framework secrets (SECRET_KEY_BASE, APP_KEY) and Service Bus.
const DEPLOY_TOOL_IMAGES = { terraform: 'hashicorp/terraform:1.16.6', helm: 'alpine/helm:3.22.1' };
const terraform = (name, cloud, backend, extraStack = {}) => ({
  stack: { ...STACKS[backend].stack, ...extraStack },
  config: { deploy: { cloud, compute: 'containers' } },
  image: DEPLOY_TOOL_IMAGES.terraform,
  entrypoint: 'sh',
  workdir: `deploy/terraform/${cloud}`,
  caches: [['terraform-plugins', '/root/.terraform.d/plugin-cache']],
  env: { TF_PLUGIN_CACHE_DIR: '/root/.terraform.d/plugin-cache', TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1' },
  build: ['terraform init -backend=false -input=false -no-color', 'terraform validate -no-color'],
  test: ['terraform fmt -check -recursive -diff -no-color']
});
STACKS['terraform-aws'] = terraform('terraform-aws', 'aws', 'rails');
STACKS['terraform-gcp'] = terraform('terraform-gcp', 'gcp', 'laravel');
STACKS['terraform-azure'] = terraform('terraform-azure', 'azure', 'nestjs', { messaging: 'servicebus' });
STACKS['terraform-azure-rabbitmq'] = terraform('terraform-azure-rabbitmq', 'azure', 'phoenix');
// Kafka on every cloud: an existing cluster given as inputs, no native broker resources.
STACKS['terraform-aws-kafka'] = terraform('terraform-aws-kafka', 'aws', 'nestjs', { messaging: 'kafka' });
STACKS['terraform-gcp-kafka'] = terraform('terraform-gcp-kafka', 'gcp', 'go', { messaging: 'kafka' });
STACKS['terraform-azure-kafka'] = terraform('terraform-azure-kafka', 'azure', 'dotnet', { messaging: 'kafka' });
STACKS.helm = {
  stack: STACKS.django.stack,
  config: { deploy: { cloud: 'gcp', compute: 'kubernetes' } },
  image: DEPLOY_TOOL_IMAGES.helm,
  entrypoint: 'sh',
  workdir: 'deploy/helm/golden-helm',
  build: ['helm lint . --strict -f values-dev.yaml', 'helm lint . --strict -f values-prod.yaml'],
  test: ['for env in dev staging prod; do helm template golden-helm . -f values-$env.yaml > /dev/null || exit 1; done', 'helm template golden-helm . -f values-prod.yaml | grep -q "kind: HorizontalPodAutoscaler"', 'helm template golden-helm . -f values-prod.yaml | grep -q "name: golden-helm-relay"']
};

// CI/CD pipelines (config.ci): actionlint (with shellcheck) for GitHub Actions; the official JSON schemas vendored in
// check-jsonschema for GitLab CI and Azure Pipelines. Nothing runs in the providers.
const ciSchema = (name, backend, provider, schema, file, extra = {}) => ({
  stack: STACKS[backend].stack,
  ...(STACKS[backend].frontendStack ? { frontendStack: STACKS[backend].frontendStack } : {}),
  config: { ci: { provider }, ...extra },
  image: 'python:3.12-slim',
  caches: [['pip', '/root/.cache/pip']],
  build: ['pip install -q check-jsonschema==0.38.2'],
  test: [`check-jsonschema --regex-variant nonunicode --builtin-schema ${schema} ${file}`]
});
STACKS['ci-github'] = {
  stack: STACKS.nestjs.stack,
  config: { ci: { provider: 'github' }, deploy: { cloud: 'aws', compute: 'containers' } },
  image: 'rhysd/actionlint:1.7.12',
  entrypoint: 'sh',
  build: ['actionlint -no-color .github/workflows/*.yml'],
  test: ['grep -q "deploy-prod:" .github/workflows/golden-ci-github.yml']
};
STACKS['ci-github-kubernetes'] = {
  stack: STACKS.django.stack,
  config: { ci: { provider: 'github' }, deploy: { cloud: 'gcp', compute: 'kubernetes' } },
  image: 'rhysd/actionlint:1.7.12',
  entrypoint: 'sh',
  build: ['actionlint -no-color .github/workflows/*.yml'],
  test: ['grep -q "helm upgrade --install" .github/workflows/golden-ci-github-kubernetes.yml']
};
STACKS['ci-gitlab'] = ciSchema('ci-gitlab', 'laravel', 'gitlab', 'vendor.gitlab-ci', '.gitlab-ci.yml');
STACKS['ci-azure-pipelines'] = ciSchema('ci-azure-pipelines', 'dotnet', 'azure-devops', 'vendor.azure-pipelines', 'azure-pipelines.yml', { deploy: { cloud: 'azure' } });

module.exports = { STACKS, SERVICEBUS_EMULATOR, PUBSUB_EMULATOR };
