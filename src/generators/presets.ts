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

export function generatePresets(parsed: ParsedFeature, config: GherkinAIConfig): { filename: string; content: string }[] {
  const lang = config.stack.language.toLowerCase();
  
  if (lang === 'java' || lang === 'kotlin') {
    return generateJavaSpringPreset(parsed);
  } else if (lang === 'python') {
    return generatePythonFastApiPreset(parsed);
  } else if (lang === 'php') {
    return generatePhpLaravelPreset(parsed);
  } else if (lang === 'csharp') {
    return generateCsharpDotnetPreset(parsed);
  } else if (lang === 'typescript' || lang === 'javascript') {
    return generateReactPlaywrightPreset(parsed);
  }

  return [];
}
