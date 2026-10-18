/* ==========================================================================
   gherkin-ai-cli - Go (chi) & Godog Preset Generator  [stable]

   Go module: domain kernel + tests, godog bound to ./features (pending,
   non-strict), the runtime kernel (PostgreSQL + RabbitMQ + OpenTelemetry)
   and the application layer wired to it (kernel/app/go.ts): chi router with
   a JWT tenant, CommandService, outbox relay goroutine.
   Verified by scripts/golden-build.js (go).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toKebab } from './kernel/domain-model';
import { renderGoKernel } from './kernel/go';
import { renderGoRuntime } from './kernel/runtime/go';
import { renderGoAppLayer } from './kernel/app/go';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';

export function goModulePath(config?: GherkinAIConfig): string {
  return toKebab(config?.projectName || 'app');
}

export function generateGoPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const siblings = siblingDomainModels(m, config, s => `internal/domain/${s.snake}.go`);
  const module = goModulePath(config);
  const app = renderGoAppLayer(m, module, tenantClaim(config), siblings);
  const replaced = new Set(app.map(f => f.filename));

  return [
    // The kernel's in-memory HTTP router and server are replaced by the application layer below.
    ...renderGoKernel(m, module).filter(f => !replaced.has(f.filename)),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified with -tags integration (docs/RUNTIME-KERNEL.md).
    ...renderGoRuntime(m, module, siblings, { messaging: config?.stack?.messaging }),
    // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, relay worker.
    ...app
  ];
}
