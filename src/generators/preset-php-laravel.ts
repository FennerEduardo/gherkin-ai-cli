/* ==========================================================================
   gherkin-ai-cli - PHP Laravel & Behat Preset Generator  [stable]

   Laravel 13 application: domain kernel (PSR-4) + PHPUnit unit tests, an API
   route executing the kernel commands (feature tests), Behat bound to
   ./features with pending steps. Verified by scripts/golden-build.js (laravel).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toKebab } from './kernel/domain-model';
import { renderPhpRuntime } from './kernel/runtime/php';
import { renderLaravelSkeleton, renderPhpKernel, renderPhpTests } from './kernel/php';
import { renderLaravelAppLayer } from './kernel/app/php';
import { tenantClaim } from './kernel/app/shared';

export function generatePhpLaravelPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const app = renderLaravelAppLayer(m, tenantClaim(config));
  const replaced = new Set(app.map(f => f.filename));
  return [
    ...renderLaravelSkeleton(m, toKebab(config?.projectName || m.kebab)),
    ...renderPhpKernel(m),
    // The kernel's in-memory API test is replaced by the application layer's tests below.
    ...renderPhpTests(m).filter(f => !replaced.has(f.filename)),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by phpunit --group integration (docs/RUNTIME-KERNEL.md).
    ...renderPhpRuntime(m),
    // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, `artisan outbox:relay`.
    ...app
  ];
}
