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
  }
};

module.exports = { STACKS };
