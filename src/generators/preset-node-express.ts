/* ==========================================================================
   gherkin-ai-cli - Node Express (TypeScript) Preset Generator  [stable]

   Express 4 API on the shared TypeScript domain kernel: jest unit + supertest
   API tests, cucumber-js bound to ./features (pending, non-strict), Prisma
   schema when orm=prisma. Verified by scripts/golden-build.js (express).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { siblingDomainModels } from './kernel/siblings';
import { buildDomainModel } from './kernel/domain-model';
import {
  renderCucumberJsConfig,
  renderCucumberJsSteps,
  renderJestConfig,
  renderTsAggregate,
  renderTsAggregateSpec,
  renderTsConfigs
} from './kernel/typescript';
import { renderTsRuntime } from './kernel/runtime/typescript';
import { renderExpressApp, renderExpressAppSpec, renderExpressHttpSpec, renderExpressServer, renderTsJwt } from './kernel/app/typescript';
import { tenantClaim } from './kernel/app/shared';

export function generateNodeExpressPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const siblings = siblingDomainModels(m, config, s => `src/domain/${s.kebab}.aggregate.ts`);
  const domain = `src/domain/${m.kebab}.aggregate`;

  return [
    { filename: `${domain}.ts`, content: renderTsAggregate(m) },
    { filename: `${domain}.spec.ts`, content: renderTsAggregateSpec(m, `./${m.kebab}.aggregate`) },
    // Application layer wired to the runtime kernel (kernel/app/shared.ts): JWT tenant, CommandService, relay worker.
    { filename: 'src/app.ts', content: renderExpressApp(m, siblings) },
    { filename: 'src/app.spec.ts', content: renderExpressAppSpec(m) },
    { filename: 'src/server.ts', content: renderExpressServer(m) },
    { filename: 'src/auth/jwt.ts', content: renderTsJwt(tenantClaim(config)) },
    { filename: `test/integration/${m.kebab}.http.int-spec.ts`, content: renderExpressHttpSpec(m) },
    { filename: `test/steps/${m.kebab}.steps.ts`, content: renderCucumberJsSteps(m, `../../${domain}`) },
    { filename: 'cucumber.js', content: renderCucumberJsConfig('test/steps/**/*.ts') },
    { filename: 'jest.config.js', content: renderJestConfig(['<rootDir>/src']) },
    { filename: 'jest.integration.config.js', content: renderJestConfig(['<rootDir>/test/integration'], { testMatch: '**/*.int-spec.ts', testTimeout: 60000 }) },
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by test/integration (docs/RUNTIME-KERNEL.md).
    ...renderTsRuntime(m, `../domain/${m.kebab}.aggregate`, siblings.map(s => ({ m: s, aggregateImport: `../domain/${s.kebab}.aggregate` }))),
    ...renderTsConfigs()
  ];
}
