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
import { RS_APP_DEPS, renderAxumAppLayer } from './kernel/app/rust';
import { tenantClaim } from './kernel/app/shared';
import { siblingDomainModels } from './kernel/siblings';

/** Cargo package (and binary) name: the snake-cased project name. */
export function rustCrateName(config?: Pick<GherkinAIConfig, 'projectName'>): string {
  const snake = toSnake(config?.projectName || 'app');
  return /^[a-z]/.test(snake) ? snake : `app_${snake}`;
}

export function generateRustAxumPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed, { service: config?.projectName });
  const crate = rustCrateName(config);
  const siblings = siblingDomainModels(m, config, s => `src/domain/${s.snake}.rs`);
  // Application layer wired to the kernel (kernel/app/shared.ts): HTTP commands, JWT tenant, relay task.
  const app = renderAxumAppLayer(m, crate, tenantClaim(config), siblings);
  const replaced = new Set(app.map(f => f.filename));
  return [
    ...renderRustProject(m, crate, featureFile || `features/${m.kebab}.feature`, siblings)
      .filter(f => !replaced.has(f.filename))
      .map(f => (f.filename === 'Cargo.toml' ? { ...f, content: f.content.replace(/^\[dependencies\]\n/m, `[dependencies]\n${RS_APP_DEPS}\n`) } : f)),
    ...app
  ];
}
