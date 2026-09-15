/* ==========================================================================
   gherkin-ai-cli - Multi-Language Presets Router
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { generateJavaSpringPreset } from './preset-java-spring';
import { generateReactPlaywrightPreset } from './preset-react-playwright';
import { generatePythonFastApiPreset } from './preset-python-fastapi';
import { generatePhpLaravelPreset } from './preset-php-laravel';
import { generateCsharpDotnetPreset } from './preset-csharp-dotnet';
import { generateGoPreset } from './preset-go';
import { generateRustAxumPreset } from './preset-rust-axum';
import { generateRubyRailsPreset } from './preset-ruby-rails';
import { generateNodeNestJsPreset } from './preset-node-nestjs';
import { generateFlutterPreset } from './preset-flutter';

import { generateVuePiniaStore } from './frontend/vue-pinia-generator';
import { generateReactReduxInfrastructure } from './frontend/react-generator';
import { generateAngularStoreInfrastructure } from './frontend/angular-ngrx-generator';
import { generateAngularSignalRService } from './frontend/angular-signalr-service';

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_/\\]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function toPascalCase(str: string): string {
  const camel = str
    .replace(/[\s_/\\]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^[A-Z]/, (m) => m.toLowerCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function generatePresets(parsed: ParsedFeature, config: GherkinAIConfig): { filename: string; content: string }[] {
  const lang = config.stack.language.toLowerCase();
  const framework = config.stack.framework?.toLowerCase() || '';
  const results: { filename: string; content: string }[] = [];
  
  if (lang === 'go') {
    results.push(...generateGoPreset(parsed));
  } else if (lang === 'rust') {
    results.push(...generateRustAxumPreset(parsed));
  } else if (lang === 'ruby') {
    results.push(...generateRubyRailsPreset(parsed));
  } else if (lang === 'dart' || framework === 'flutter') {
    results.push(...generateFlutterPreset(parsed));
  } else if (lang === 'java' || lang === 'kotlin') {
    results.push(...generateJavaSpringPreset(parsed));
  } else if (lang === 'python') {
    results.push(...generatePythonFastApiPreset(parsed));
  } else if (lang === 'php') {
    results.push(...generatePhpLaravelPreset(parsed));
  } else if (lang === 'csharp') {
    results.push(...generateCsharpDotnetPreset(parsed, config));
  } else if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs') {
      results.push(...generateNodeNestJsPreset(parsed));
    } else {
      results.push(...generateReactPlaywrightPreset(parsed));
    }
  }

  // Complementary Frontend Dual-Stack Matrix Generation
  if (config.frontendStack && config.frontendStack.framework !== 'none') {
    const feFramework = config.frontendStack.framework.toLowerCase();
    const safeFeatureName = toPascalCase(parsed.featureName);
    const kebabFeatureName = toKebabCase(parsed.featureName);

    if (feFramework === 'vue') {
      results.push({
        filename: `frontend/stores/${kebabFeatureName}.store.ts`,
        content: generateVuePiniaStore(safeFeatureName)
      });
    } else if (feFramework === 'react') {
      results.push({
        filename: `frontend/store/${kebabFeatureName}Slice.ts`,
        content: generateReactReduxInfrastructure(safeFeatureName)
      });
    } else if (feFramework === 'angular') {
      const mode = config.frontendStack.stateManagement === 'classic' ? 'classic' : 'signals';
      results.push({
        filename: `frontend/store/${kebabFeatureName}.store.ts`,
        content: generateAngularStoreInfrastructure(safeFeatureName, mode)
      });
      results.push({
        filename: `frontend/services/signalr-notification.service.ts`,
        content: generateAngularSignalRService(safeFeatureName)
      });
    }
  }

  return results;
}

