/* ==========================================================================
   gherkin-ai-cli - Stack support tiers

   stable:       a sample project is generated, compiled AND its generated
                 test suite run on every CI build (scripts/golden-build.js);
                 breaking changes follow semver.
   beta:         generators are unit-tested but generated projects are not
                 built in CI; expect manual fixes.
   experimental: skeletons only; may change at any time.

   Keep in sync with scripts/golden-stacks.js.
   ========================================================================== */

import type { GherkinAIConfig } from '../core/config';

export type SupportTier = 'stable' | 'beta' | 'experimental';
export type StackKind = 'backend' | 'frontend' | 'contracts';

export interface StackSupport {
  id: string;
  label: string;
  kind: StackKind;
  tier: SupportTier;
  /** Golden build entry that verifies it (scripts/golden-stacks.js). */
  golden?: string;
  notes?: string;
}

export const STACK_SUPPORT: StackSupport[] = [
  { id: 'typescript/nestjs', label: 'TypeScript · NestJS + Prisma', kind: 'backend', tier: 'stable', golden: 'nestjs' },
  { id: 'typescript/express', label: 'TypeScript · Express', kind: 'backend', tier: 'stable', golden: 'express' },
  { id: 'csharp/dotnet', label: 'C# · ASP.NET Core 8 + EF Core', kind: 'backend', tier: 'stable', golden: 'dotnet' },
  { id: 'java/spring', label: 'Java 17 · Spring Boot 3 (Maven)', kind: 'backend', tier: 'stable', golden: 'java' },
  { id: 'kotlin/spring', label: 'Kotlin · Spring Boot 3 (Gradle)', kind: 'backend', tier: 'stable', golden: 'kotlin', notes: 'Pattern infrastructure is shared Java code compiled alongside Kotlin.' },
  { id: 'python/fastapi', label: 'Python · FastAPI + SQLAlchemy', kind: 'backend', tier: 'stable', golden: 'fastapi' },
  { id: 'python/django', label: 'Python · Django + DRF', kind: 'backend', tier: 'stable', golden: 'django' },
  { id: 'go/chi', label: 'Go · chi', kind: 'backend', tier: 'stable', golden: 'go' },
  { id: 'php/laravel', label: 'PHP · Laravel 13', kind: 'backend', tier: 'stable', golden: 'laravel' },
  { id: 'ruby/rails', label: 'Ruby · Rails 8 (API)', kind: 'backend', tier: 'stable', golden: 'rails' },
  { id: 'elixir/phoenix', label: 'Elixir · Phoenix', kind: 'backend', tier: 'stable', golden: 'phoenix' },
  { id: 'rust/axum', label: 'Rust · Axum', kind: 'backend', tier: 'stable', golden: 'rust' },
  { id: 'dart/flutter', label: 'Dart · Flutter (standalone app)', kind: 'backend', tier: 'stable', golden: 'flutter' },

  { id: 'frontend/react', label: 'React 19 · Redux Toolkit · Vite', kind: 'frontend', tier: 'stable', golden: 'react' },
  { id: 'frontend/vue', label: 'Vue 3 · Pinia · Vite', kind: 'frontend', tier: 'stable', golden: 'vue' },
  { id: 'frontend/angular', label: 'Angular 22 · NgRx Signals', kind: 'frontend', tier: 'stable', golden: 'angular' },
  { id: 'frontend/nextjs', label: 'Next.js 16 (App Router)', kind: 'frontend', tier: 'stable', golden: 'nextjs' },
  { id: 'frontend/react-native', label: 'React Native · Expo SDK 57', kind: 'frontend', tier: 'stable', golden: 'react-native' },
  { id: 'frontend/flutter', label: 'Flutter', kind: 'frontend', tier: 'stable', golden: 'flutter-frontend' },
  { id: 'frontend/phoenix-liveview', label: 'Phoenix LiveView', kind: 'frontend', tier: 'stable', golden: 'phoenix-liveview', notes: 'Requires the Phoenix backend.' },

  { id: 'contracts/grpc', label: 'gRPC (Protobuf, buf-linted)', kind: 'contracts', tier: 'stable', golden: 'grpc-graphql', notes: 'Enable with contracts.grpc: true.' },
  { id: 'contracts/graphql', label: 'GraphQL SDL', kind: 'contracts', tier: 'stable', golden: 'grpc-graphql', notes: 'Enable with contracts.graphql: true.' }
];

const find = (id: string) => STACK_SUPPORT.find(s => s.id === id)!;
const FRONTEND_ALIASES: Record<string, string> = {
  react: 'react', vue: 'vue', angular: 'angular', nextjs: 'nextjs', next: 'nextjs', 'react-native': 'react-native', expo: 'react-native'
};

/** Maps a project config to its backend support entry (mirrors the routing in presets.ts). */
export function getStackSupport(config: Pick<GherkinAIConfig, 'stack'>): StackSupport {
  const lang = config.stack.language.toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();

  if (lang === 'kotlin') return find('kotlin/spring');
  if (lang === 'java') return find('java/spring');
  if (lang === 'csharp' || lang === 'dotnet' || lang === '.net') return find('csharp/dotnet');
  if (lang === 'python') return framework === 'django' ? find('python/django') : find('python/fastapi');
  if (lang === 'go') return find('go/chi');
  if (lang === 'php') return find('php/laravel');
  if (lang === 'ruby') return find('ruby/rails');
  if (lang === 'elixir') return find('elixir/phoenix');
  if (lang === 'rust') return find('rust/axum');
  if (lang === 'dart' || framework === 'flutter') return find('dart/flutter');
  if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs' || framework === 'nest') return find('typescript/nestjs');
    if (framework === 'express') return find('typescript/express');
    // Frontend-only project (see frontendFramework() in presets.ts).
    const frontendOnly = FRONTEND_ALIASES[framework];
    if (frontendOnly) return find(`frontend/${frontendOnly}`);
  }
  return {
    id: `${lang}/${framework || 'unknown'}`,
    label: `${lang} ${framework}`.trim(),
    kind: 'backend',
    tier: 'experimental',
    notes: 'No dedicated preset: only contracts and prompts are generated.'
  };
}

export function supportWarning(support: StackSupport): string | undefined {
  if (support.tier === 'stable') return undefined;
  const base = support.tier === 'beta'
    ? `${support.label} support is BETA: generated code is not built in CI and may need manual fixes.`
    : `${support.label} support is EXPERIMENTAL: expect skeletons and breaking changes.`;
  return support.notes ? `${base} ${support.notes}` : base;
}
