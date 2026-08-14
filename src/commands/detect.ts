/* ==========================================================================
   gherkin-ai-cli - 'detect' Command Handler (Brownfield Project Detector)
   ========================================================================== */

import path from 'path';
import { detectExistingStack } from '../core/stack-detector';
import { saveConfig } from '../core/config';
import { logger } from '../utils/logger';

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

  const targetPath = path.join(process.cwd(), 'gherkin-ai.config.json');
  saveConfig(detectedConfig, targetPath);

  logger.success(`Saved detected project configuration to: ${targetPath}`);
  logger.info('You can now add feature contracts directly to your project using:');
  logger.info('  ghk add --feature ./specs/my-feature.feature --target ./src/modules/my-feature');
}
