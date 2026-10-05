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

export function generateElixirPhoenixPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const base = config?.projectName || 'app';
  const otp = /^[a-z]/.test(toSnake(base)) ? toSnake(base) : `app_${toSnake(base)}`;
  const mod = /^[A-Z]/.test(toPascal(base)) ? toPascal(base) : `App${toPascal(base)}`;
  const liveview = /live-?view/i.test(config?.frontendStack?.framework || "");
  return renderElixirProject(m, { otp, mod }, featureFile || `features/${m.kebab}.feature`, { liveview });
}
