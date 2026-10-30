/* ==========================================================================
   gherkin-ai-cli - Multi-Language Presets Router
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaSpringPreset } from './preset-java-spring';
import { generateKotlinSpringPreset } from './preset-kotlin-spring';
import { generateKotlinQuarkusPreset } from './preset-kotlin-quarkus';
import { generateJavaQuarkusPreset } from './preset-java-quarkus';
import { generatePythonFastApiPreset } from './preset-python-fastapi';
import { generatePythonDjangoPreset } from './preset-python-django';
import { generatePhpLaravelPreset } from './preset-php-laravel';
import { generateCsharpDotnetPreset } from './preset-csharp-dotnet';
import { generateGoPreset } from './preset-go';
import { generateRustAxumPreset } from './preset-rust-axum';
import { generateRubyRailsPreset } from './preset-ruby-rails';
import { generateElixirPhoenixPreset } from './preset-elixir-phoenix';
import { generateNodeNestJsPreset } from './preset-node-nestjs';
import { generateNodeExpressPreset } from './preset-node-express';
import { dartPackageName, generateFlutterPreset } from './preset-flutter';
import { renderFlutterProject } from './frontend/kernel/flutter';

import { getStackSupport } from './stack-support';
import { ConfigError } from '../core/errors';
import { bffFramework, isBff } from './bff/model';
import { renderTsBff } from './bff/typescript';
import { renderSpringBff } from './bff/spring';
import { renderContainerFiles } from './deploy/container';
import { buildDomainModel } from './kernel/domain-model';
import { siblingDomainModels } from './kernel/siblings';
import { VALIDATE_CONTRACTS_SCRIPT, renderGraphql, renderProto } from './kernel/api-contracts';
import { renderReactProject } from './frontend/kernel/react';
import { renderVueProject } from './frontend/kernel/vue';
import { renderAngularProject } from './frontend/kernel/angular';
import { renderNextProject } from './frontend/kernel/nextjs';
import { renderReactNativeProject } from './frontend/kernel/react-native';

// A `stack` of language dart / framework flutter is routed to the Flutter preset above instead.
const FRONTEND_FRAMEWORKS = ['react', 'vue', 'angular', 'nextjs', 'next', 'react-native', 'expo'];

/**
 * The frontend to render: `frontendStack.framework`, or the `stack.framework` of a TypeScript /
 * JavaScript project that only declares a frontend (e.g. stack: { language: 'typescript', framework: 'react' }).
 */
export function frontendFramework(config: Pick<GherkinAIConfig, 'stack' | 'frontendStack'>): string | undefined {
  const fe = config.frontendStack?.framework?.toLowerCase();
  if (fe && fe !== 'none') return fe;
  const lang = config.stack.language.toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();
  if ((lang === 'typescript' || lang === 'javascript') && FRONTEND_FRAMEWORKS.includes(framework)) return framework;
  return undefined;
}

type BackendPreset = (parsed: ParsedFeature, config: GherkinAIConfig, featureFile?: string) => { filename: string; content: string }[];

/** Backend preset per stack-support id (stack-support.ts decides which id a config resolves to). */
const BACKEND_PRESETS: Record<string, BackendPreset> = {
  'csharp/dotnet': (p, c) => generateCsharpDotnetPreset(p, c),
  'java/spring': (p, c) => generateJavaSpringPreset(p, c),
  'java/quarkus': (p, c) => generateJavaQuarkusPreset(p, c),
  'kotlin/spring': (p, c) => generateKotlinSpringPreset(p, c),
  'kotlin/quarkus': (p, c) => generateKotlinQuarkusPreset(p, c),
  'python/fastapi': generatePythonFastApiPreset,
  'python/django': generatePythonDjangoPreset,
  'go/chi': (p, c) => generateGoPreset(p, c),
  'php/laravel': (p, c) => generatePhpLaravelPreset(p, c),
  'ruby/rails': (p, c) => generateRubyRailsPreset(p, c),
  'elixir/phoenix': generateElixirPhoenixPreset,
  'rust/axum': generateRustAxumPreset,
  'dart/flutter': generateFlutterPreset
};

/** Ids every generated backend id must have a preset for (tests/generators/stack-support.test.ts). */
export const BACKEND_PRESET_IDS = Object.keys(BACKEND_PRESETS);

function backendPreset(id: string): BackendPreset | undefined {
  // NestJS / Express variants (framework and ORM majors) share one preset each.
  if (id.startsWith('typescript/nestjs')) return (p, c) => generateNodeNestJsPreset(p, c);
  if (id.startsWith('typescript/express')) return (p, c) => generateNodeExpressPreset(p, c);
  return BACKEND_PRESETS[id];
}

/** stack.role "bff": a stateless gateway instead of a command service (bff/model.ts). */
function bffPreset(config: GherkinAIConfig): BackendPreset {
  const framework = bffFramework(config);
  if (!framework) {
    throw new ConfigError(`stack.role "bff" is not generated for ${config.stack.language} / ${config.stack.framework}.`, {
      hint: 'The BFF role is generated for TypeScript (Express, NestJS) and Java (Spring Boot). Other stacks get the contracts and prompts only: drop stack.role.'
    });
  }
  return framework === 'spring' ? (p, c) => renderSpringBff(p, c) : (p, c) => renderTsBff(p, c, framework);
}

/** @param featureFile path of the source .feature relative to the project root, when known (used by BDD runners that bind one file). */
export function generatePresets(parsed: ParsedFeature, config: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const results: { filename: string; content: string }[] = [];

  // Frontend-only stacks (`frontend/*`) are rendered below; unsupported stacks (experimental
  // tier, e.g. Kotlin + Ktor) only get contracts and prompts.
  const backend = isBff(config) ? bffPreset(config) : backendPreset(getStackSupport(config).id);
  if (backend) {
    results.push(...backend(parsed, config, featureFile));
    // Production image (Dockerfile + .dockerignore) for container platforms (ECS, Cloud Run, Container Apps, Kubernetes).
    results.push(...renderContainerFiles(config));
  }

  // Complementary Frontend Dual-Stack Matrix Generation (or a frontend-only project declared in `stack`).
  const feFramework = frontendFramework(config);
  if (feFramework) {
    const fm = buildDomainModel(parsed);
    if (feFramework === 'vue') {
      results.push(...renderVueProject(fm, 'frontend', siblingDomainModels(fm, config, s => `frontend/src/components/${s.pascal}Panel.vue`)));
    } else if (feFramework === 'react') {
      results.push(...renderReactProject(fm, 'frontend', siblingDomainModels(fm, config, s => `frontend/src/components/${s.pascal}Panel.tsx`)));
    } else if (feFramework === 'angular') {
      results.push(...renderAngularProject(fm, 'frontend', siblingDomainModels(fm, config, s => `frontend/src/app/${s.kebab}-panel.component.ts`),
        { realtime: ['csharp', 'dotnet'].includes(config.stack.language) }));
    } else if (feFramework === 'nextjs' || feFramework === 'next') {
      results.push(...renderNextProject(fm, 'frontend', siblingDomainModels(fm, config, s => `frontend/components/${s.pascal}Panel.tsx`)));
    } else if (feFramework === 'react-native' || feFramework === 'expo') {
      results.push(...renderReactNativeProject(fm, 'frontend', siblingDomainModels(fm, config, s => `frontend/src/${s.pascal}Screen.tsx`)));
    } else if (feFramework === 'flutter') {
      // The frontend package lives in ./frontend; the feature file is one level up.
      const feature = featureFile ? `../${featureFile}` : `../features/${fm.kebab}.feature`;
      results.push(...renderFlutterProject(fm, { root: 'frontend', packageName: `${dartPackageName(config.projectName || fm.snake)}_app`, featurePathFromPackage: feature, siblings: siblingDomainModels(fm, config, s => `frontend/lib/${s.snake}_panel.dart`) }));
    }
  }

  // Optional non-REST contracts (contracts.grpc / contracts.graphql), from the same domain model.
  if (config.contracts?.grpc || config.contracts?.graphql) {
    const cm = buildDomainModel(parsed);
    if (config.contracts.grpc) results.push(...renderProto(cm));
    if (config.contracts.graphql) {
      results.push(renderGraphql(cm));
      results.push({ filename: 'contracts/validate-graphql.cjs', content: VALIDATE_CONTRACTS_SCRIPT });
    }
  }

  return results;
}

