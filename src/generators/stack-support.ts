/* ==========================================================================
   gherkin-ai-cli - Stack support tiers

   stable:       generated code is compiled and tested in CI (golden builds);
                 breaking changes follow semver.
   beta:         generators are covered by unit tests but generated projects
                 are not compiled in CI; expect manual fixes.
   experimental: step definitions / skeletons only; may change at any time.
   ========================================================================== */

import type { GherkinAIConfig } from '../core/config';

export type SupportTier = 'stable' | 'beta' | 'experimental';

export interface StackSupport {
  id: string;
  label: string;
  tier: SupportTier;
  notes?: string;
}

export const STACK_SUPPORT: StackSupport[] = [
  { id: 'typescript/nestjs', label: 'TypeScript · NestJS + Prisma', tier: 'stable' },
  { id: 'csharp/dotnet', label: 'C# · ASP.NET Core + EF Core', tier: 'stable' },
  { id: 'java/spring', label: 'Java · Spring Boot', tier: 'beta' },
  { id: 'python/fastapi', label: 'Python · FastAPI', tier: 'beta' },
  { id: 'go', label: 'Go', tier: 'beta' },
  { id: 'php/laravel', label: 'PHP · Laravel', tier: 'beta' },
  { id: 'typescript/react', label: 'TypeScript · React + Playwright', tier: 'beta' },
  { id: 'kotlin/spring', label: 'Kotlin · Spring Boot', tier: 'experimental', notes: 'Reuses the Java preset; Kotlin contracts only.' },
  { id: 'ruby/rails', label: 'Ruby · Rails', tier: 'experimental', notes: 'Step definitions only.' },
  { id: 'rust/axum', label: 'Rust · Axum', tier: 'experimental', notes: 'Step definitions only.' },
  { id: 'dart/flutter', label: 'Dart · Flutter', tier: 'experimental', notes: 'Step definitions only.' }
];

/** Maps a project config to its support entry (mirrors the routing in presets.ts). */
export function getStackSupport(config: Pick<GherkinAIConfig, 'stack'>): StackSupport {
  const lang = config.stack.language.toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();
  const find = (id: string) => STACK_SUPPORT.find(s => s.id === id)!;

  if (lang === 'kotlin') return find('kotlin/spring');
  if (lang === 'java') return find('java/spring');
  if (lang === 'csharp') return find('csharp/dotnet');
  if (lang === 'python') return find('python/fastapi');
  if (lang === 'go') return find('go');
  if (lang === 'php') return find('php/laravel');
  if (lang === 'ruby') return find('ruby/rails');
  if (lang === 'rust') return find('rust/axum');
  if (lang === 'dart' || framework === 'flutter') return find('dart/flutter');
  if ((lang === 'typescript' || lang === 'javascript') && framework === 'nestjs') return find('typescript/nestjs');
  if (lang === 'typescript' || lang === 'javascript') return find('typescript/react');
  return { id: `${lang}/${framework || 'unknown'}`, label: `${lang} ${framework}`.trim(), tier: 'experimental', notes: 'No dedicated preset.' };
}

export function supportWarning(support: StackSupport): string | undefined {
  if (support.tier === 'stable') return undefined;
  const base = support.tier === 'beta'
    ? `${support.label} support is BETA: generated code is not compiled in CI and may need manual fixes.`
    : `${support.label} support is EXPERIMENTAL: expect skeletons and breaking changes.`;
  return support.notes ? `${base} ${support.notes}` : base;
}
