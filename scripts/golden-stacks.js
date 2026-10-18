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

/**
 * Azure Service Bus emulator config: its entities are fixed at startup, so it declares the runtime tests'
 * topology ("it") and the service's own (Topology.DEFAULT, named after the project).
 */
function serviceBusConfig(prefixes) {
  const subscription = name => ({
    Name: name,
    Properties: { DeadLetteringOnMessageExpiration: false, DefaultMessageTimeToLive: 'PT1H', LockDuration: 'PT1M', MaxDeliveryCount: 10, ForwardDeadLetteredMessagesTo: '', ForwardTo: '', RequiresSession: false },
    Rules: []
  });
  const topic = (name, sub) => ({
    Name: name,
    Properties: { DefaultMessageTimeToLive: 'PT1H', DuplicateDetectionHistoryTimeWindow: 'PT20S', RequiresDuplicateDetection: false },
    Subscriptions: [subscription(sub)]
  });
  return JSON.stringify({
    UserConfig: {
      Namespaces: [{ Name: 'sbemulatorns', Queues: [], Topics: prefixes.flatMap(p => [topic(`${p}.events`, `${p}.consumer`), topic(`${p}.dlx`, `${p}.dlq`)]) }],
      Logging: { Type: 'File' }
    }
  }, null, 2);
}

const SQL_EDGE_PASSWORD = 'Ghk-Golden-2026!';

/** Azure Service Bus emulator and the SQL Edge database it needs, selected with GHK_BROKER=servicebus. */
const SERVICEBUS_EMULATOR = project => [
  {
    name: 'sqledge',
    image: 'mcr.microsoft.com/azure-sql-edge:latest',
    environment: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: SQL_EDGE_PASSWORD },
    readyLog: 'SQL Server is now ready for client connections'
  },
  {
    name: 'servicebus',
    image: 'mcr.microsoft.com/azure-messaging/servicebus-emulator:latest',
    environment: { SQL_SERVER: 'sqledge', MSSQL_SA_PASSWORD: SQL_EDGE_PASSWORD, ACCEPT_EULA: 'Y' },
    files: { '/ServiceBus_Emulator/ConfigFiles/Config.json': serviceBusConfig(['it', project]) },
    readyLog: 'Emulator Service is Successfully Up!',
    env: {
      GHK_BROKER: 'servicebus',
      SERVICEBUS_CONNECTION_STRING: 'Endpoint=sb://servicebus;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
    }
  }
];

/** Google Cloud Pub/Sub emulator (src/core/services.ts extra service), selected with GHK_BROKER=pubsub. */
const PUBSUB_EMULATOR = {
  name: 'pubsub',
  image: 'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators',
  command: ['gcloud', 'beta', 'emulators', 'pubsub', 'start', '--host-port=0.0.0.0:8085', '--project=ghk-golden'],
  ready: ['curl', '-sf', 'http://localhost:8085'],
  env: { GHK_BROKER: 'pubsub', PUBSUB_EMULATOR_HOST: 'pubsub:8085', PUBSUB_PROJECT_ID: 'ghk-golden' }
};

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
    image: 'gradle:8.10-jdk17',
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
    services: messaging === 'servicebus' ? SERVICEBUS_EMULATOR(project) : [PUBSUB_EMULATOR]
  };
}

// Service Bus only where an official SDK exists (no Rust, Ruby, Elixir or PHP SDK: RabbitMQ / CloudAMQP on Azure).
const NATIVE_BROKERS = { dotnet: ['pubsub', 'servicebus'], fastapi: ['pubsub', 'servicebus'], go: ['pubsub', 'servicebus'], rust: ['pubsub'], rails: ['pubsub'], phoenix: ['pubsub'], laravel: ['pubsub'] };
for (const [name, brokers] of Object.entries(NATIVE_BROKERS)) {
  for (const messaging of brokers) STACKS[`${name}-${messaging}`] = withBroker(name, messaging);
}

module.exports = { STACKS, SERVICEBUS_EMULATOR, PUBSUB_EMULATOR };
