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

export function generateRubyRailsPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const appModule = toPascal(config?.projectName || 'App');
  return [...renderRubyKernel(m), ...renderRailsApp(m, /^[A-Z]/.test(appModule) ? appModule : `App${appModule}`)];
}
