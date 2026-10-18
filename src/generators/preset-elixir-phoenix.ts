/* ==========================================================================
   gherkin-ai-cli - Elixir Phoenix (API) Preset Generator  [stable]

   Mix project: functional domain kernel + ExUnit tests, Phoenix JSON API
   (Bandit) with ConnTest tests, and an ExUnit binder for ./features
   (scenarios skipped while pending, undefined steps fail).
   Verified by scripts/golden-build.js (phoenix).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toPascal, toSnake } from './kernel/domain-model';
import { renderElixirProject } from './kernel/elixir';
import { renderPhoenixAppLayer } from './kernel/app/elixir';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';

export function generateElixirPhoenixPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const base = config?.projectName || 'app';
  const otp = /^[a-z]/.test(toSnake(base)) ? toSnake(base) : `app_${toSnake(base)}`;
  const mod = /^[A-Z]/.test(toPascal(base)) ? toPascal(base) : `App${toPascal(base)}`;
  const liveview = /live-?view/i.test(config?.frontendStack?.framework || "");
  const siblings = siblingDomainModels(m, config, s => `lib/${otp}/domain/${s.snake}_aggregate.ex`);
  // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, Postgrex pool, relay worker.
  const app = renderPhoenixAppLayer(m, { otp, mod }, tenantClaim(config), { liveview });
  const replaced = new Set(app.map(f => f.filename));
  return [
    ...renderElixirProject(m, { otp, mod }, featureFile || `features/${m.kebab}.feature`, { liveview, siblings, messaging: config?.stack?.messaging }).filter(f => !replaced.has(f.filename)),
    ...app
  ];
}
