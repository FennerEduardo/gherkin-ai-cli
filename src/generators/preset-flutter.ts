/* ==========================================================================
   gherkin-ai-cli - Flutter (Dart) Preset Generator  [stable]

   Flutter package at the project root (language: dart / framework: flutter).
   As a frontend next to another backend, see frontend/kernel/flutter.ts.
   Verified by scripts/golden-build.js (flutter).
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildDomainModel, toSnake } from './kernel/domain-model';
import { renderFlutterProject } from './frontend/kernel/flutter';

export function dartPackageName(name: string): string {
  const snake = toSnake(name);
  return /^[a-z]/.test(snake) ? snake : `app_${snake}`;
}

export function generateFlutterPreset(parsed: ParsedFeature, config?: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const m = buildDomainModel(parsed);
  return renderFlutterProject(m, {
    packageName: dartPackageName(config?.projectName || m.snake),
    featurePathFromPackage: featureFile || `features/${m.kebab}.feature`
  });
}
