/* ==========================================================================
   gherkin-ai-cli - PHP Laravel & Behat Preset Generator  [stable]

   Laravel 13 application: domain kernel (PSR-4) + PHPUnit unit tests, an API
   route executing the kernel commands (feature tests), Behat bound to
   ./features with pending steps. Verified by scripts/golden-build.js (laravel).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toKebab } from './kernel/domain-model';
import { renderLaravelSkeleton, renderPhpController, renderPhpKernel, renderPhpTests } from './kernel/php';

export function generatePhpLaravelPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  return [
    ...renderLaravelSkeleton(m, toKebab(config?.projectName || m.kebab)),
    ...renderPhpKernel(m),
    renderPhpController(m),
    ...renderPhpTests(m)
  ];
}
