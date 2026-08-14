/* ==========================================================================
   gherkin-ai-cli - 'add' Command Handler (Brownfield Contract Injector)
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { detectExistingStack } from '../core/stack-detector';
import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { generatePrompts } from '../generators/prompts';
import { fileExistsSync, readFileSync, writeFileSync, ensureDirSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleAddCommand(options: { feature?: string; target?: string; config?: string }): Promise<void> {
  logger.banner();

  if (!options.feature) {
    logger.error('Missing required option: --feature <file>');
    logger.info('Usage: ghk add --feature ./specs/my-feature.feature [--target ./src/modules/my-feature]');
    process.exit(1);
  }

  const featurePath = path.resolve(process.cwd(), options.feature);
  if (!fileExistsSync(featurePath)) {
    logger.error(`Feature file not found at: ${featurePath}`);
    process.exit(1);
  }

  // Load config or auto-detect if config doesn't exist
  let config = loadConfig(options.config);
  if (!options.config && !fileExistsSync(path.join(process.cwd(), 'gherkin-ai.config.json'))) {
    logger.info('No config file found. Auto-detecting existing project stack...');
    config = detectExistingStack(process.cwd());
  }

  logger.info(`Reading Gherkin spec from: ${featurePath}`);
  const gherkinText = readFileSync(featurePath);
  const parsed = parseGherkinText(gherkinText);

  const featurePascal = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') || 'Feature';
  const targetDir = options.target 
    ? path.resolve(process.cwd(), options.target) 
    : path.resolve(process.cwd(), 'src', 'modules', featurePascal.toLowerCase());

  ensureDirSync(targetDir);
  logger.info(`Injecting contracts & AI prompts into: ${targetDir}`);

  // 1. Generate Contracts & OpenAPI
  const { contractsTs, adrMd, openApiJson } = generateContracts(parsed, config);
  const contractFileName = `${featurePascal.toLowerCase()}.contract.ts`;
  
  writeFileSync(path.join(targetDir, contractFileName), contractsTs);
  writeFileSync(path.join(targetDir, `${featurePascal.toLowerCase()}.openapi.json`), openApiJson);
  writeFileSync(path.join(targetDir, `ADR-${featurePascal}.md`), adrMd);
  logger.success(`Created contract file: ${path.join(targetDir, contractFileName)}`);

  // 2. Generate Agent Prompts inside target module
  const promptsDir = path.join(targetDir, 'prompts');
  ensureDirSync(promptsDir);

  const prompts = generatePrompts(parsed, config);
  Object.keys(prompts).forEach(filename => {
    writeFileSync(path.join(promptsDir, filename), prompts[filename]);
  });
  logger.success(`Created specialized AI prompts inside: ${promptsDir}`);

  logger.banner();
  logger.success(`Contracts & AI prompts injected into existing project at ${targetDir}!`);
  logger.info(`Now your AI Coding Agent can consume ${contractFileName} directly inside your module.`);
}
