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

function nestGolden(stack = {}) {
  return {
    stack: { ...base, language: 'typescript', framework: 'nestjs', orm: 'prisma', validation: 'zod', messaging: 'rabbitmq', testing: 'jest', ...stack },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test', `node -e "import('./dist/src/app.module.js').then(m => { if (!m.AppModule) process.exit(1); })"`]
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
  'grpc-graphql': {
    stack: { ...base, language: 'typescript', framework: 'nestjs', orm: 'prisma', validation: 'zod', testing: 'jest' },
    config: { contracts: { grpc: true, graphql: true } },
    image: 'node:24-bookworm',
    workdir: 'contracts',
    caches: [['npm', '/root/.npm']],
    build: ['npx --yes @bufbuild/buf@1 build', 'npx --yes @bufbuild/buf@1 lint'],
    test: ['npm install --no-save --no-audit --no-fund --loglevel=error graphql@16', 'node validate-graphql.cjs']
  },
  express: {
    stack: { ...base, language: 'typescript', framework: 'express', orm: 'prisma', validation: 'zod', testing: 'jest' },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test']
  },
  'express-prisma7': {
    stack: { ...base, language: 'typescript', framework: 'express', orm: 'prisma', ormVersion: '7', validation: 'zod', testing: 'jest' },
    image: 'node:24-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test']
  },
  dotnet: {
    stack: { ...base, language: 'csharp', framework: 'dotnet-aspnetcore', orm: 'efcore', validation: 'fluentvalidation', messaging: 'rabbitmq', testing: 'xunit' },
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    caches: [['nuget', '/root/.nuget/packages']],
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
    // The test project references the app project, so this builds both.
    build: ['dotnet build tests/*/*.Tests.csproj -nologo -v q'],
    // Integration tests need Docker (Testcontainers) and run separately.
    test: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category!=Integration"']
  },
  java: {
    stack: { ...base, language: 'java', framework: 'spring-boot', orm: 'hibernate', validation: 'jakarta-validation', testing: 'junit' },
    image: 'maven:3.9-eclipse-temurin-17',
    caches: [['m2', '/root/.m2']],
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test']
  },
  kotlin: {
    stack: { ...base, language: 'kotlin', framework: 'spring-boot', orm: 'hibernate', validation: 'jakarta-validation', testing: 'junit' },
    image: 'gradle:8.10-jdk17',
    caches: [['gradle', '/cache/gradle']],
    env: { GRADLE_USER_HOME: '/cache/gradle' },
    build: ['gradle -q --no-daemon assemble'],
    test: ['gradle --no-daemon test']
  },
  fastapi: {
    stack: { ...base, language: 'python', framework: 'fastapi', orm: 'sqlalchemy', validation: 'pydantic', testing: 'pytest' },
    image: 'python:3.12-slim',
    caches: [['pip', '/root/.cache/pip']],
    env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    build: ['pip install -q -e ".[test]"', 'python -m compileall -q app'],
    test: ['pytest -q -rs']
  },
  django: {
    stack: { ...base, language: 'python', framework: 'django', orm: 'django-orm', validation: 'drf', testing: 'pytest' },
    image: 'python:3.12-slim',
    caches: [['pip', '/root/.cache/pip']],
    env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    build: ['pip install -q -e ".[test]"', 'python -m compileall -q app config', 'python manage.py check'],
    test: ['pytest -q -rs']
  },
  go: {
    stack: { ...base, language: 'go', framework: 'chi', orm: 'pgx', validation: 'go-playground', testing: 'testing' },
    image: 'golang:1.22',
    caches: [['gomod', '/go/pkg/mod'], ['gobuild', '/root/.cache/go-build']],
    build: ['go mod tidy', 'go vet ./...', 'go build ./...'],
    test: ['go test ./...']
  },
  rails: {
    stack: { ...base, language: 'ruby', framework: 'rails', orm: 'none', validation: 'active-model', testing: 'rspec' },
    image: 'ruby:3.3',
    caches: [['gems', '/usr/local/bundle']],
    env: { RAILS_ENV: 'test' },
    build: ['bundle install --quiet --jobs 4', 'ruby -c config/application.rb > /dev/null', 'bin/rails runner "puts Rails.version" > /dev/null'],
    test: ['bundle exec rspec', 'bundle exec cucumber']
  },
  phoenix: {
    stack: { ...base, language: 'elixir', framework: 'phoenix', orm: 'none', validation: 'ecto-changeset', testing: 'exunit' },
    image: 'elixir:1.17',
    caches: [['mix', '/root/.mix'], ['hex', '/root/.hex']],
    env: { MIX_ENV: 'test' },
    build: ['mix local.hex --force --if-missing > /dev/null', 'mix local.rebar --force --if-missing > /dev/null', 'mix deps.get > /dev/null', 'mix compile --warnings-as-errors'],
    test: ['mix test']
  },
  rust: {
    stack: { ...base, language: 'rust', framework: 'axum', orm: 'none', validation: 'serde', testing: 'cargo-test' },
    image: 'rust:1.99',
    caches: [['cargo-registry', '/usr/local/cargo/registry'], ['cargo-git', '/usr/local/cargo/git']],
    build: ['cargo build --all-targets --quiet'],
    test: ['cargo test --quiet']
  },
  'phoenix-liveview': {
    stack: { ...base, language: 'elixir', framework: 'phoenix', orm: 'none', validation: 'ecto-changeset', testing: 'exunit' },
    frontendStack: { framework: 'phoenix-liveview', language: 'elixir' },
    image: 'elixir:1.17',
    caches: [['mix', '/root/.mix'], ['hex', '/root/.hex']],
    env: { MIX_ENV: 'test' },
    build: ['mix local.hex --force --if-missing > /dev/null', 'mix local.rebar --force --if-missing > /dev/null', 'mix deps.get > /dev/null', 'mix compile --warnings-as-errors'],
    test: ['mix test']
  },
  laravel: {
    stack: { ...base, language: 'php', framework: 'laravel', orm: 'eloquent', validation: 'laravel-validation', testing: 'phpunit' },
    image: 'composer:2',
    caches: [['composer', '/tmp/composer-cache']],
    env: { COMPOSER_CACHE_DIR: '/tmp/composer-cache', COMPOSER_NO_INTERACTION: '1' },
    build: [
      'composer install --no-progress --prefer-dist -q',
      'find app routes tests features contracts bootstrap -name "*.php" -print0 | xargs -0 -n1 php -l > /dev/null',
      'php artisan --version'
    ],
    test: ['vendor/bin/phpunit', 'vendor/bin/behat --no-colors --format=progress']
  }
};

module.exports = { STACKS };
