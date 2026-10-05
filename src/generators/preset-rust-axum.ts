/* ==========================================================================
   gherkin-ai-cli - Rust Axum Preset Generator  [stable]

   Cargo crate: domain kernel + unit tests, Axum router with oneshot
   integration tests, and a cargo-test binder for ./features (undefined
   steps fail, pending steps are reported). Verified by golden-build (rust).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toSnake } from './kernel/domain-model';
import { renderRustProject } from './kernel/rust';

export function generateRustAxumPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  const snake = toSnake(config?.projectName || 'app');
  const crate = /^[a-z]/.test(snake) ? snake : `app_${snake}`;
  return renderRustProject(m, crate, featureFile || `features/${m.kebab}.feature`);
}
