/* ==========================================================================
   gherkin-ai-cli - NestJS (cucumber-js) Preset Generator  [stable]

   Produces a self-contained project: domain kernel + unit tests (jest),
   cucumber-js steps bound to the feature (pending), NestJS bootstrap,
   enterprise patterns (outbox, idempotency, saga, multitenancy, CQRS) and
   build/test configuration. Verified by scripts/golden-build.js (nestjs).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig, defaultConfig } from '../core/config';
import { generateNestJsMultiTenancyInfrastructure } from './nestjs/multitenancy-generator';
import {
  renderNestAppModule,
  renderNestController,
  renderNestFeatureModule,
  renderNestHttpSpec,
  renderNestRuntimeModule,
  renderNestTenantGuard,
  renderTsJwt
} from './kernel/app/typescript';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';
import { buildDomainModel } from './kernel/domain-model';
import { resolveNodeProfile, withEsmImportExtensions } from './node-profile';
import { renderTsRuntime } from './kernel/runtime/typescript';
import {
  renderCucumberJsConfig,
  renderCucumberJsSteps,
  renderJestConfig,
  renderTsAggregate,
  renderTsAggregateSpec,
  renderTsConfigs
} from './kernel/typescript';

export function generateNodeNestJsPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  // The service's other features: the runtime command service handles all of them.
  const siblings = siblingDomainModels(m, config, s => `src/${s.kebab}/domain/${s.kebab}.aggregate.ts`);
  // NestJS 12 is ESM-only: see node-profile.ts.
  const profile = resolveNodeProfile(config ?? defaultConfig);
  const esm = profile.esm;
  const domainDir = `src/${m.kebab}/domain`;
  const aggregateFromFeature = `./domain/${m.kebab}.aggregate`;

  const appModule = // Service-wide: imports the module of every generated feature.
  renderNestAppModule([m, ...siblings].map(f => ({ pascal: f.pascal, kebab: f.kebab })));

  const main = `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startTelemetry, stopTelemetry } from './runtime/otel';

async function bootstrap(): Promise<void> {
  // OTLP export when OTEL_EXPORTER_OTLP_ENDPOINT is set (runtime/otel.ts).
  startTelemetry();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  process.once('SIGTERM', () => void stopTelemetry());
  await app.listen(Number(process.env.PORT) || 3000);
}

void bootstrap();
`;

  const results = [
    { filename: `${domainDir}/${m.kebab}.aggregate.ts`, content: renderTsAggregate(m) },
    { filename: `${domainDir}/${m.kebab}.aggregate.spec.ts`, content: renderTsAggregateSpec(m, `./${m.kebab}.aggregate`) },
    { filename: `test/steps/${m.kebab}.steps.ts`, content: renderCucumberJsSteps(m, `../../${domainDir}/${m.kebab}.aggregate`) },
    { filename: 'cucumber.js', content: renderCucumberJsConfig('test/steps/**/*.ts', { esm }) },
    { filename: 'jest.config.js', content: renderJestConfig(['<rootDir>/src'], { esm }) },
    { filename: 'jest.integration.config.js', content: renderJestConfig(['<rootDir>/test/integration'], { esm, testMatch: '**/*.int-spec.ts', testTimeout: 60000 }) },
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by test/integration (docs/RUNTIME-KERNEL.md).
    ...renderTsRuntime(m, `../${m.kebab}/domain/${m.kebab}.aggregate`, siblings.map(s => ({ m: s, aggregateImport: `../${s.kebab}/domain/${s.kebab}.aggregate` })), { messaging: config?.stack?.messaging }),
    ...renderTsConfigs(),
    { filename: 'src/app.module.ts', content: appModule },
    { filename: 'src/main.ts', content: main },
    // Application layer wired to the runtime kernel (src/generators/kernel/app/shared.ts):
    // HTTP commands, JWT tenant, outbox relay worker. Idempotency, outbox and sagas live in src/runtime.
    { filename: 'src/runtime/runtime.module.ts', content: renderNestRuntimeModule(m) },
    { filename: 'src/auth/jwt.ts', content: renderTsJwt(tenantClaim(config)) },
    { filename: 'src/auth/jwt-tenant.guard.ts', content: renderNestTenantGuard() },
    { filename: `src/${m.kebab}/${m.kebab}.controller.ts`, content: renderNestController(m, aggregateFromFeature) },
    { filename: `src/${m.kebab}/${m.kebab}.module.ts`, content: renderNestFeatureModule(m) },
    { filename: `test/integration/${m.kebab}.http.int-spec.ts`, content: renderNestHttpSpec(m) },
    ...generateNestJsMultiTenancyInfrastructure(profile)
  ];

  // prisma/schema.prisma comes from the Prisma plugin (prisma-stack.ts), with one model per feature.

  // ES modules: Node resolves relative imports only with the emitted extension.
  return esm ? results.map(f => (f.filename.endsWith('.ts') ? { ...f, content: withEsmImportExtensions(f.content) } : f)) : results;
}
