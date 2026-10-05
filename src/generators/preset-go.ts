/* ==========================================================================
   gherkin-ai-cli - Go (chi) & Godog Preset Generator  [stable]

   Go module: domain kernel + tests, chi HTTP API + httptest, godog bound
   to ./features (pending, non-strict), pgx-based patterns (outbox, saga,
   idempotency, multitenancy), each in its own package.
   Verified by scripts/golden-build.js (go).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateGoOutboxInfrastructure } from './go/go-outbox-generator';
import { generateGoSagaInfrastructure } from './go/go-saga-generator';
import { generateGoIdempotencyInfrastructure } from './go/go-idempotency-generator';
import { generateGoMultiTenancyInfrastructure } from './go/go-multitenancy-generator';
import { buildDomainModel, toKebab } from './kernel/domain-model';
import { renderGoKernel } from './kernel/go';
import { renderGoRuntime } from './kernel/runtime/go';

export function goModulePath(config?: GherkinAIConfig): string {
  return toKebab(config?.projectName || 'app');
}

export function generateGoPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const module = goModulePath(config);
  // Each Go directory is its own package.
  const under = (dir: string, files: { filename: string; content: string }[]) =>
    files.map(f => ({ filename: `${dir}/${f.filename.split('/').pop()}`, content: f.content }));

  return [
    ...renderGoKernel(m, module),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified with -tags integration (docs/RUNTIME-KERNEL.md).
    ...renderGoRuntime(m, module),
    ...under('internal/infrastructure/outbox', generateGoOutboxInfrastructure('outbox')),
    ...under('internal/infrastructure/idempotency', generateGoIdempotencyInfrastructure('idempotency')),
    ...under('internal/infrastructure/multitenancy', generateGoMultiTenancyInfrastructure('multitenancy')),
    ...under('internal/sagas', generateGoSagaInfrastructure('sagas', m.pascal))
  ];
}
