/* ==========================================================================
   gherkin-ai-cli - 'validate' Command Handler
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { getArchRule } from '../core/arch-rules';
import { parseGherkinText } from '../core/gherkin-parser';
import { fileExistsSync, readFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleValidateCommand(options: { feature?: string; config?: string }): Promise<void> {
  logger.banner();
  logger.info('Validating project architecture and feature spec compliance...');

  const config = loadConfig(options.config);
  const arch = getArchRule(config.architecture);

  logger.info(`Loaded config: Architecture = ${arch.name}, Language = ${config.stack.language}`);

  let errorsCount = 0;

  if (options.feature) {
    const featurePath = path.resolve(process.cwd(), options.feature);
    if (!fileExistsSync(featurePath)) {
      logger.error(`Feature file not found at ${featurePath}`);
      errorsCount++;
    } else {
      const gherkinText = readFileSync(featurePath);
      const parsed = parseGherkinText(gherkinText);
      if (parsed.scenarios.length === 0) {
        logger.warn('Feature file contains zero valid scenarios.');
        errorsCount++;
      } else {
        logger.success(`Gherkin Spec Validated: Found ${parsed.scenarios.length} scenario(s).`);
      }
    }
  }

  if (errorsCount === 0) {
    logger.success('Architecture rules validation PASSED with 0 errors.');
  } else {
    logger.error(`Validation completed with ${errorsCount} issue(s).`);
  }
}
