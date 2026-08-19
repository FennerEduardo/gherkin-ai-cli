/* ==========================================================================
   gherkin-ai-cli - 'detect' Command Handler (Brownfield Project Detector)
   ========================================================================== */

import path from 'path';
import inquirer from 'inquirer';
import { detectExistingStack } from '../core/stack-detector';
import { saveConfig } from '../core/config';
import { logger } from '../utils/logger';
import { suggestPatterns } from '../core/patterns-suggester';

export async function handleDetectCommand(): Promise<void> {
  logger.banner();
  logger.info('Scanning project directory for existing stack & architecture...');

  const detectedConfig = detectExistingStack(process.cwd());

  console.log('\n------------------------------------------------------------');
  console.log('🔍 Existing Project Stack & Architecture Detected:');
  console.log(`- Project Name: ${detectedConfig.projectName}`);
  console.log(`- Project Mode: ${detectedConfig.projectMode}`);
  console.log(`- Architecture Style: ${detectedConfig.architecture}`);
  console.log(`- Language / Runtime: ${detectedConfig.stack.language}`);
  console.log(`- Framework: ${detectedConfig.stack.framework}`);
  console.log(`- ORM / Persistence: ${detectedConfig.stack.orm}`);
  console.log(`- Database: ${detectedConfig.stack.database}`);
  console.log(`- Validation Library: ${detectedConfig.stack.validation}`);
  console.log(`- Testing Framework: ${detectedConfig.stack.testing}`);
  console.log('------------------------------------------------------------\n');

  const { confirmStack } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmStack',
    message: 'Is the detected stack correct?',
    default: true
  }]);

  if (!confirmStack) {
    logger.warn('You can manually edit the generated gherkin-ai.config.json to reflect your actual stack.');
  }

  const suggestions = suggestPatterns(detectedConfig.stack, detectedConfig.architecture);
  if (suggestions.designPatterns.length > 0 || suggestions.codingRules.length > 0) {
    console.log('\n💡 Suggested Patterns & Rules based on your stack:');
    if (suggestions.designPatterns.length > 0) {
        console.log(`- Design Patterns: ${suggestions.designPatterns.join(', ')}`);
    }
    if (suggestions.codingRules.length > 0) {
        console.log(`- Coding Rules: ${suggestions.codingRules.join(' | ')}`);
    }
    const { applySuggestions } = await inquirer.prompt([{
      type: 'confirm',
      name: 'applySuggestions',
      message: 'Do you want to apply these design patterns and coding rules to your configuration?',
      default: true
    }]);

    if (applySuggestions) {
      detectedConfig.designPatterns = suggestions.designPatterns;
      detectedConfig.codingRules = suggestions.codingRules;
    }
  }

  const targetPath = path.join(process.cwd(), 'gherkin-ai.config.json');
  saveConfig(detectedConfig, targetPath);

  logger.success(`Saved detected project configuration to: ${targetPath}`);
  logger.info('You can now add feature contracts directly to your project using:');
  logger.info('  ghk add --feature ./specs/my-feature.feature --target ./src/modules/my-feature');
}
