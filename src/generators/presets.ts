/* ==========================================================================
   gherkin-ai-cli - Multi-Language Presets Router
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaSpringPreset } from './preset-java-spring';
import { generateKotlinSpringPreset } from './preset-kotlin-spring';
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

import { buildDomainModel } from './kernel/domain-model';
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

/** @param featureFile path of the source .feature relative to the project root, when known (used by BDD runners that bind one file). */
export function generatePresets(parsed: ParsedFeature, config: GherkinAIConfig, featureFile?: string): { filename: string; content: string }[] {
  const lang = config.stack.language.toLowerCase();
  const framework = config.stack.framework?.toLowerCase() || '';
  const results: { filename: string; content: string }[] = [];
  
  if (lang === 'go') {
    results.push(...generateGoPreset(parsed, config));
  } else if (lang === 'rust') {
    results.push(...generateRustAxumPreset(parsed, config, featureFile));
  } else if (lang === 'elixir') {
    results.push(...generateElixirPhoenixPreset(parsed, config, featureFile));
  } else if (lang === 'ruby') {
    results.push(...generateRubyRailsPreset(parsed, config));
  } else if (lang === 'dart' || framework === 'flutter') {
    results.push(...generateFlutterPreset(parsed, config, featureFile));
  } else if (lang === 'kotlin') {
    results.push(...generateKotlinSpringPreset(parsed, config));
  } else if (lang === 'java') {
    results.push(...generateJavaSpringPreset(parsed, config));
  } else if (lang === 'python') {
    if (framework === 'django') results.push(...generatePythonDjangoPreset(parsed, config, featureFile));
    else results.push(...generatePythonFastApiPreset(parsed, config, featureFile));
  } else if (lang === 'php') {
    results.push(...generatePhpLaravelPreset(parsed, config));
  } else if (lang === 'csharp') {
    results.push(...generateCsharpDotnetPreset(parsed, config));
  } else if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs' || framework === 'nest') {
      results.push(...generateNodeNestJsPreset(parsed, config));
    } else if (framework === 'express') {
      results.push(...generateNodeExpressPreset(parsed, config));
    }
    // Frontend frameworks in `stack` are rendered below as a frontend-only project; other TypeScript
    // backends (fastify, node-native, ...) have no preset: only contracts and prompts are generated.
  }

  // Complementary Frontend Dual-Stack Matrix Generation (or a frontend-only project declared in `stack`).
  const feFramework = frontendFramework(config);
  if (feFramework) {
    const fm = buildDomainModel(parsed);
    if (feFramework === 'vue') {
      results.push(...renderVueProject(fm));
    } else if (feFramework === 'react') {
      results.push(...renderReactProject(fm));
    } else if (feFramework === 'angular') {
      results.push(...renderAngularProject(fm));
    } else if (feFramework === 'nextjs' || feFramework === 'next') {
      results.push(...renderNextProject(fm));
    } else if (feFramework === 'react-native' || feFramework === 'expo') {
      results.push(...renderReactNativeProject(fm));
    } else if (feFramework === 'flutter') {
      // The frontend package lives in ./frontend; the feature file is one level up.
      const feature = featureFile ? `../${featureFile}` : `../features/${fm.kebab}.feature`;
      results.push(...renderFlutterProject(fm, { root: 'frontend', packageName: `${dartPackageName(config.projectName || fm.snake)}_app`, featurePathFromPackage: feature }));
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

