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

export function generatePresets(parsed: ParsedFeature, config: GherkinAIConfig): { filename: string; content: string }[] {
  const lang = config.stack.language.toLowerCase();
  const framework = config.stack.framework?.toLowerCase() || '';
  
  if (lang === 'go') {
    return generateGoPreset(parsed);
  } else if (lang === 'rust') {
    return generateRustAxumPreset(parsed);
  } else if (lang === 'ruby') {
    return generateRubyRailsPreset(parsed);
  } else if (lang === 'dart' || framework === 'flutter') {
    return generateFlutterPreset(parsed);
  } else if (lang === 'java' || lang === 'kotlin') {
    return generateJavaSpringPreset(parsed);
  } else if (lang === 'python') {
    return generatePythonFastApiPreset(parsed);
  } else if (lang === 'php') {
    return generatePhpLaravelPreset(parsed);
  } else if (lang === 'csharp') {
    return generateCsharpDotnetPreset(parsed);
  } else if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs') {
      return generateNodeNestJsPreset(parsed);
    }
    return generateReactPlaywrightPreset(parsed);
  }

  return [];
}
