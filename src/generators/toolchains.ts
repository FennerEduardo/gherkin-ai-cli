/* ==========================================================================
   gherkin-ai-cli - Toolchain per stack: the container image and the commands
   that build and test a generated project.

   Single source of truth for `ghk verify --docker`, `ghk implement --docker`
   and the docker-compose dev service. scripts/golden-stacks.js runs the same
   images in CI; tests/generators/toolchains.test.ts keeps them in sync.
   ========================================================================== */

import type { GherkinAIConfig } from '../core/config';
import { getStackSupport } from './stack-support';
import { PHP_RUNTIME_EXTENSIONS } from './kernel/runtime/php';

export interface Toolchain {
  /** Official image the generated project is built and tested in. */
  image: string;
  /** Commands that restore dependencies and compile (need network for the first run). */
  build: string[];
  /** Commands that run the generated unit/BDD tests. */
  test: string[];
  /** Commands that run the runtime integration suite (need DATABASE_URL / AMQP_URL). */
  integration?: string[];
  /** Command that starts the application. */
  start: string;
  env?: Record<string, string>;
  /**
   * Dependency caches as [volume, container path]: mounted as the named volume `ghk-cache-<volume>`, which
   * stays writable under the sandbox's read-only root and is shared with the golden builds.
   */
  caches?: [string, string][];
}

/**
 * Where each toolchain keeps its downloads, and the variables that point it there (the strict sandbox sets
 * HOME=/tmp, so caches that default to $HOME are named explicitly).
 */
const CACHES: [RegExp, Pick<Toolchain, 'caches' | 'env'>][] = [
  [/^(typescript|javascript|frontend)\//, { caches: [['npm', '/root/.npm']], env: { npm_config_cache: '/root/.npm' } }],
  [/^csharp\//, { caches: [['nuget', '/root/.nuget/packages']], env: { NUGET_PACKAGES: '/root/.nuget/packages' } }],
  [/^java\//, { caches: [['m2', '/root/.m2']], env: { MAVEN_OPTS: '-Dmaven.repo.local=/root/.m2/repository' } }],
  [/^kotlin\//, { caches: [['gradle', '/cache/gradle']], env: { GRADLE_USER_HOME: '/cache/gradle' } }],
  [/^python\//, { caches: [['pip', '/root/.cache/pip']], env: { PIP_CACHE_DIR: '/root/.cache/pip', PIP_DISABLE_PIP_VERSION_CHECK: '1' } }],
  [/^go\//, { caches: [['gomod', '/go/pkg/mod'], ['gobuild', '/root/.cache/go-build']], env: { GOCACHE: '/root/.cache/go-build', GOFLAGS: '-modcacherw' } }],
  [/^ruby\//, { caches: [['gems', '/usr/local/bundle']] }],
  [/^elixir\//, { caches: [['mix', '/root/.mix'], ['hex', '/root/.hex']], env: { MIX_HOME: '/root/.mix', HEX_HOME: '/root/.hex' } }],
  [/^rust\//, { caches: [['cargo-registry', '/usr/local/cargo/registry'], ['cargo-git', '/usr/local/cargo/git']] }],
  [/^php\//, { caches: [['composer', '/tmp/composer-cache']], env: { COMPOSER_CACHE_DIR: '/tmp/composer-cache', COMPOSER_NO_INTERACTION: '1' } }],
  [/^dart\//, { caches: [['pub', '/root/.pub-cache']], env: { PUB_CACHE: '/root/.pub-cache' } }]
];

function withCaches(id: string, toolchain: Toolchain | undefined): Toolchain | undefined {
  if (!toolchain) return undefined;
  const cache = CACHES.find(([pattern]) => pattern.test(id))?.[1];
  return cache ? { ...toolchain, caches: cache.caches, env: { ...cache.env, ...toolchain.env } } : toolchain;
}

const NODE_IMAGE = 'node:24-bookworm';

const node = (start: string): Toolchain => ({
  image: NODE_IMAGE,
  build: ['npm install --no-audit --no-fund --loglevel=error', 'npm run build'],
  test: ['npm test'],
  integration: ['npm run test:integration'],
  start
});

export const TOOLCHAINS: Record<string, Toolchain> = {
  'typescript/nestjs': node('npm start'),
  'typescript/express': node('npm start'),
  'csharp/dotnet': {
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    build: ['dotnet build tests/*/*.Tests.csproj -nologo -v q'],
    test: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category!=Integration&Category!=Testcontainers"'],
    integration: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category=Integration"'],
    start: 'dotnet run',
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  },
  'java/spring': {
    image: 'maven:3.9-eclipse-temurin-17',
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration'],
    start: 'mvn -B -ntp spring-boot:run'
  },
  'java/quarkus': {
    image: 'maven:3.9-eclipse-temurin-21',
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp test -Pintegration'],
    start: 'mvn -B -ntp quarkus:dev -Dquarkus.http.host=0.0.0.0'
  },
  'kotlin/quarkus': {
    image: 'gradle:8.14-jdk21',
    build: ['gradle -q --no-daemon assemble'],
    test: ['gradle --no-daemon test'],
    integration: ['gradle --no-daemon integrationTest'],
    start: 'gradle --no-daemon quarkusDev -Dquarkus.http.host=0.0.0.0'
  },
  'kotlin/spring': {
    image: 'gradle:8.14-jdk17',
    build: ['gradle -q --no-daemon assemble'],
    test: ['gradle --no-daemon test'],
    integration: ['gradle --no-daemon integrationTest'],
    start: 'gradle --no-daemon bootRun'
  },
  'python/fastapi': {
    image: 'python:3.12-slim',
    build: ['pip install -q -e ".[test]"'],
    test: ['pytest -q -rs -m "not integration"'],
    integration: ['pytest -q -rs -m integration'],
    start: 'uvicorn app.main:app --host 0.0.0.0 --port 8000'
  },
  'python/django': {
    image: 'python:3.12-slim',
    build: ['pip install -q -e ".[test]"', 'python manage.py check'],
    test: ['pytest -q -rs -m "not integration"'],
    integration: ['pytest -q -rs -m integration'],
    start: 'python manage.py runserver 0.0.0.0:8000'
  },
  'go/chi': {
    image: 'golang:1.26',
    build: ['go mod tidy', 'go vet ./...', 'go build ./...'],
    test: ['go test ./...'],
    integration: ['go test -tags integration -count=1 ./internal/runtime/...'],
    start: 'go run ./cmd/server'
  },
  'php/laravel': {
    image: 'composer:2',
    build: [PHP_RUNTIME_EXTENSIONS, 'composer install --no-progress --prefer-dist -q'],
    test: ['vendor/bin/phpunit --exclude-group integration', 'vendor/bin/behat --no-colors --format=progress'],
    integration: ['vendor/bin/phpunit --group integration'],
    start: 'php artisan serve --host 0.0.0.0'
  },
  'ruby/rails': {
    image: 'ruby:3.3',
    build: ['bundle install --quiet --jobs 4'],
    test: ['bundle exec rspec --tag ~integration', 'bundle exec cucumber'],
    integration: ['bundle exec rspec --tag integration'],
    start: 'bin/rails server -b 0.0.0.0',
    env: { RAILS_ENV: 'test' }
  },
  'elixir/phoenix': {
    image: 'elixir:1.17',
    build: ['mix local.hex --force --if-missing', 'mix local.rebar --force --if-missing', 'mix deps.get', 'mix compile'],
    test: ['mix test'],
    integration: ['mix test --only integration'],
    start: 'mix phx.server',
    env: { MIX_ENV: 'test' }
  },
  'rust/axum': {
    image: 'rust:1.99',
    build: ['cargo build --all-targets --quiet'],
    test: ['cargo test --quiet'],
    integration: ['cargo test --quiet --features integration --test runtime_integration --test http_integration -- --test-threads=1'],
    start: 'cargo run'
  },
  'dart/flutter': {
    image: 'ghcr.io/cirruslabs/flutter:stable',
    build: ['flutter pub get', 'flutter analyze --no-fatal-infos'],
    test: ['flutter test'],
    start: 'flutter run'
  }
};

export interface AppRuntimeEnv {
  /** Port the started application listens on. */
  port: number;
  /** Framework variables for local development (.env.example). */
  vars: Record<string, string>;
  /**
   * HTTP probes of the running service (container platforms, Helm, Terraform). Default: /health for both;
   * `ready` also checks the database where the stack implements it.
   */
  health?: { live: string; ready: string };
}

const DEFAULT_HEALTH = { live: '/health', ready: '/health' };

/** Liveness / readiness paths of a backend. */
export function resolveHealth(config: Pick<GherkinAIConfig, 'stack'>): { live: string; ready: string } {
  // NestJS checks the database in /health/ready (RuntimeModule); Express shares the node entry and has /health only.
  if (getStackSupport(config).id.startsWith('typescript/nestjs')) return { live: '/health', ready: '/health/ready' };
  return resolveAppRuntimeEnv(config).health ?? DEFAULT_HEALTH;
}

/** How each backend is configured when run locally; DATABASE_URL / AMQP_URL are added for every stack. */
export const APP_RUNTIME_ENV: Record<string, AppRuntimeEnv> = {
  node: { port: 3000, vars: { NODE_ENV: 'development', PORT: '3000' } },
  'csharp/dotnet': { port: 8080, vars: { ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: 'http://0.0.0.0:8080' } },
  'java/spring': { port: 8080, vars: { SPRING_PROFILES_ACTIVE: 'dev', SERVER_PORT: '8080' }, health: { live: '/health', ready: '/health/ready' } },
  'java/quarkus': { port: 8080, vars: { QUARKUS_PROFILE: 'dev', SERVER_PORT: '8080' }, health: { live: '/q/health/live', ready: '/q/health/ready' } },
  'kotlin/quarkus': { port: 8080, vars: { QUARKUS_PROFILE: 'dev', SERVER_PORT: '8080' }, health: { live: '/q/health/live', ready: '/q/health/ready' } },
  'kotlin/spring': { port: 8080, vars: { SPRING_PROFILES_ACTIVE: 'dev', SERVER_PORT: '8080' }, health: { live: '/health', ready: '/health/ready' } },
  'python/fastapi': { port: 8000, vars: { APP_ENV: 'development' } },
  'python/django': { port: 8000, vars: { APP_ENV: 'development', DJANGO_DEBUG: 'true' } },
  'go/chi': { port: 8080, vars: { APP_ENV: 'development', PORT: '8080' } },
  'php/laravel': { port: 8000, vars: { APP_ENV: 'local', APP_DEBUG: 'true' }, health: { live: '/up', ready: '/up' } },
  'ruby/rails': { port: 3000, vars: { RAILS_ENV: 'development', PORT: '3000' } },
  'elixir/phoenix': { port: 4000, vars: { MIX_ENV: 'dev', PORT: '4000' } },
  'rust/axum': { port: 3000, vars: { RUST_LOG: 'info', PORT: '3000' } }
};

export function resolveAppRuntimeEnv(config: Pick<GherkinAIConfig, 'stack'>): AppRuntimeEnv {
  const id = getStackSupport(config).id;
  if (id.startsWith('typescript/') || id.startsWith('frontend/')) return APP_RUNTIME_ENV.node;
  return APP_RUNTIME_ENV[id] ?? APP_RUNTIME_ENV.node;
}

/** Toolchain for a project config (NestJS / Express variants share the Node toolchain). */
export function resolveToolchain(config: Pick<GherkinAIConfig, 'stack'>): Toolchain | undefined {
  const id = getStackSupport(config).id;
  if (id.startsWith('typescript/nestjs')) return withCaches(id, TOOLCHAINS['typescript/nestjs']);
  if (id.startsWith('typescript/express')) return withCaches(id, TOOLCHAINS['typescript/express']);
  if (id.startsWith('frontend/')) return withCaches(id, node('npm run dev'));
  return withCaches(id, TOOLCHAINS[id]);
}
