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

const STACKS = {
  nestjs: {
    stack: { ...base, language: 'typescript', framework: 'nestjs', orm: 'prisma', validation: 'zod', messaging: 'rabbitmq', testing: 'jest' },
    image: 'node:20-bookworm',
    caches: [['npm', '/root/.npm']],
    build: ['npm install --no-audit --no-fund --loglevel=error', 'npx prisma generate', 'npm run build'],
    test: ['npm test']
  },
  express: {
    stack: { ...base, language: 'typescript', framework: 'express', orm: 'prisma', validation: 'zod', testing: 'jest' },
    image: 'node:20-bookworm',
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
