/* ==========================================================================
   gherkin-ai-cli - NestJS (cucumber-js) Preset Generator  [stable]

   Produces a self-contained project: domain kernel + unit tests (jest),
   cucumber-js steps bound to the feature (pending), NestJS bootstrap,
   enterprise patterns (outbox, idempotency, saga, multitenancy, CQRS) and
   build/test configuration. Verified by scripts/golden-build.js (nestjs).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig, defaultConfig } from '../core/config';
import { buildIR } from '../core/ir-builder';
import { generatePrismaSchema } from './prisma-generator';
import { generateNestJsCqrsModules } from './nestjs/cqrs-generator';
import { generateNestJsOutboxInfrastructure } from './nestjs/outbox-generator';
import { generateNestJsIdempotencyInterceptor } from './nestjs/idempotency-generator';
import { generateNestJsSagaInfrastructure } from './nestjs/saga-generator';
import { generateNestJsMultiTenancyInfrastructure } from './nestjs/multitenancy-generator';
import { buildDomainModel } from './kernel/domain-model';
import { resolveNodeProfile, withEsmImportExtensions } from './node-profile';
import {
  renderCucumberJsConfig,
  renderCucumberJsSteps,
  renderJestConfig,
  renderTsAggregate,
  renderTsAggregateSpec,
  renderTsConfigs
} from './kernel/typescript';

export function generateNodeNestJsPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  // NestJS 12 is ESM-only: see node-profile.ts.
  const profile = resolveNodeProfile(config ?? defaultConfig);
  const esm = profile.esm;
  const domainDir = `src/${m.kebab}/domain`;

  const appModule = `import { Module } from '@nestjs/common';
import { ApplicationCqrsModule } from './${m.kebab}/${m.kebab}.cqrs';

@Module({
  imports: [ApplicationCqrsModule]
})
export class AppModule {}
`;

  const main = `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
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
    ...renderTsConfigs(),
    { filename: 'src/app.module.ts', content: appModule },
    { filename: 'src/main.ts', content: main },
    { filename: `src/${m.kebab}/${m.kebab}.cqrs.ts`, content: generateNestJsCqrsModules() },
    { filename: `src/infrastructure/outbox.service.ts`, content: generateNestJsOutboxInfrastructure() },
    { filename: `src/infrastructure/idempotency.interceptor.ts`, content: generateNestJsIdempotencyInterceptor() },
    ...generateNestJsSagaInfrastructure(m.pascal),
    ...generateNestJsMultiTenancyInfrastructure(profile)
  ];

  if (config) {
    const ir = buildIR(parsed, 'feature.feature');
    results.push({ filename: 'prisma/schema.prisma', content: generatePrismaSchema(ir, config) });
  }

  // ES modules: Node resolves relative imports only with the emitted extension.
  return esm ? results.map(f => (f.filename.endsWith('.ts') ? { ...f, content: withEsmImportExtensions(f.content) } : f)) : results;
}
