/* ==========================================================================
   gherkin-ai-cli - Ruby on Rails (API) & Cucumber Preset Generator  [stable]

   Rails 8 API app (no database required): domain kernel autoloaded from
   app/domain, RSpec unit + request specs, Cucumber bound to ./features with
   pending steps. Verified by scripts/golden-build.js (rails).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toPascal } from './kernel/domain-model';
import { renderRailsApp, renderRubyKernel } from './kernel/ruby';
import { renderRbRuntime } from './kernel/runtime/ruby';
import { renderRailsAppLayer } from './kernel/app/ruby';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';

export function generateRubyRailsPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const siblings = siblingDomainModels(m, config, s => `app/domain/${s.snake}_aggregate.rb`);
  const appModule = toPascal(config?.projectName || 'App');
  const app = renderRailsAppLayer(m, tenantClaim(config), siblings);
  const replaced = new Set(app.map(f => f.filename));
  return [
    ...renderRubyKernel(m),
    // The skeleton's in-memory controller and its request spec are replaced by the application layer below.
    ...renderRailsApp(m, /^[A-Z]/.test(appModule) ? appModule : `App${appModule}`, siblings).filter(f => !replaced.has(f.filename)),
    // Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry, verified by rspec --tag integration (docs/RUNTIME-KERNEL.md).
    ...renderRbRuntime(m, siblings),
    // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, `rails outbox:relay`.
    ...app
  ];
}
