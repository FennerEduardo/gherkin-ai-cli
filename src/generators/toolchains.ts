/* ==========================================================================
   gherkin-ai-cli - Toolchain per stack: the container image and the commands
   that build and test a generated project.

   Single source of truth for `ghk verify --docker`, `ghk implement --docker`
   and the docker-compose dev service. scripts/golden-stacks.js runs the same
   images in CI; tests/generators/toolchains.test.ts keeps them in sync.
   ========================================================================== */

import type { GherkinAIConfig } from '../core/config';
import { getStackSupport } from './stack-support';

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
    test: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category!=Integration"'],
    integration: ['dotnet test tests/*/*.Tests.csproj -nologo -v q --no-build --filter "Category=Integration"'],
    start: 'dotnet run',
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  },
  'java/spring': {
    image: 'maven:3.9-eclipse-temurin-17',
    build: ['mvn -q -B -ntp -DskipTests package'],
    test: ['mvn -B -ntp test'],
    integration: ['mvn -B -ntp verify -Pintegration'],
    start: 'mvn -B -ntp spring-boot:run'
  },
  'kotlin/spring': {
    image: 'gradle:8.10-jdk17',
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
    image: 'golang:1.22',
    build: ['go mod tidy', 'go vet ./...', 'go build ./...'],
    test: ['go test ./...'],
    integration: ['go test -tags integration -count=1 ./internal/runtime/...'],
    start: 'go run ./cmd/server'
  },
  'php/laravel': {
    image: 'composer:2',
    build: ['composer install --no-progress --prefer-dist -q'],
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
    integration: ['cargo test --quiet --features integration -- --test-threads=1'],
    start: 'cargo run'
  },
  'dart/flutter': {
    image: 'ghcr.io/cirruslabs/flutter:stable',
    build: ['flutter pub get', 'flutter analyze --no-fatal-infos'],
    test: ['flutter test'],
    start: 'flutter run'
  }
};

/** Toolchain for a project config (NestJS / Express variants share the Node toolchain). */
export function resolveToolchain(config: Pick<GherkinAIConfig, 'stack'>): Toolchain | undefined {
  const id = getStackSupport(config).id;
  if (id.startsWith('typescript/nestjs')) return TOOLCHAINS['typescript/nestjs'];
  if (id.startsWith('typescript/express')) return TOOLCHAINS['typescript/express'];
  if (id.startsWith('frontend/')) return node('npm run dev');
  return TOOLCHAINS[id];
}
