/* ==========================================================================
   gherkin-ai-cli - 'add' Command Handler (Brownfield Contract Injector)
   ========================================================================== */

import path from 'path';
import inquirer from 'inquirer';
import { loadConfig } from '../core/config';
import { detectExistingStack } from '../core/stack-detector';
import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { generatePrompts } from '../generators/prompts';
import { handleCreateCommand } from './create';
import { fileExistsSync, readFileSync, writeFileSync, ensureDirSync } from '../utils/file-system';
import { logger } from '../utils/logger';

export async function handleAddCommand(options: { feature?: string; target?: string; config?: string }): Promise<void> {
  logger.banner();

  if (!options.feature) {
    logger.info('No --feature file specified. Launching interactive spec wizard...');
    await handleCreateCommand({ target: options.target });
    return;
  }

  const featurePath = path.resolve(process.cwd(), options.feature);

  if (!fileExistsSync(featurePath)) {
    logger.warn(`Feature file not found at: ${featurePath}`);
    
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'createNow',
        message: '¿Deseas crear la especificación Gherkin paso a paso ahora (wizard interactivo)?',
        default: true
      }
    ]);

    if (answer.createNow) {
      await handleCreateCommand({ output: options.feature, target: options.target });
      return;
    } else {
      process.exit(1);
    }
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

  // 1. Generate Contracts, OpenAPI, AsyncAPI & Native Language Contract
  const { contractsTs, adrMd, openApiJson, asyncApiJson, nativeContract } = generateContracts(parsed, config);
  const contractFileName = `${featurePascal.toLowerCase()}.contract.ts`;
  
  writeFileSync(path.join(targetDir, contractFileName), contractsTs);
  writeFileSync(path.join(targetDir, `${featurePascal.toLowerCase()}.openapi.json`), openApiJson);
  writeFileSync(path.join(targetDir, `${featurePascal.toLowerCase()}.asyncapi.json`), asyncApiJson);
  writeFileSync(path.join(targetDir, `ADR-${featurePascal}.md`), adrMd);
  logger.success(`Created contract file: ${path.join(targetDir, contractFileName)}`);

  if (nativeContract) {
    writeFileSync(path.join(targetDir, nativeContract.filename), nativeContract.content);
    logger.success(`Created language-native contract file: ${path.join(targetDir, nativeContract.filename)}`);
  }

  // 2. Generate Test Stubs
  const testsDir = path.join(targetDir, '__tests__');
  ensureDirSync(testsDir);
  let stubContent = `// Auto-generated Test Stub for ${featurePascal}\n\n`;
  stubContent += `describe('${parsed.featureName}', () => {\n`;
  parsed.scenarios.forEach(sc => {
    stubContent += `  describe('Scenario: ${sc.name}', () => {\n`;
    sc.steps.forEach(st => {
      stubContent += `    it('${st.keyword} ${st.text.replace(/'/g, "\\'")}', async () => {\n      // TODO: Implement step\n    });\n`;
    });
    stubContent += `  });\n`;
  });
  stubContent += `});\n`;
  writeFileSync(path.join(testsDir, `${featurePascal.toLowerCase()}.stub.spec.ts`), stubContent);
  logger.success(`Created test stubs inside: ${testsDir}`);

  // 3. Generate Agent Prompts inside target module
  const promptsDir = path.join(targetDir, 'prompts');
  ensureDirSync(promptsDir);

  const prompts = generatePrompts(parsed, config);
  Object.keys(prompts).forEach(filename => {
    writeFileSync(path.join(promptsDir, filename), prompts[filename]);
  });
  logger.success(`Created specialized AI prompts inside: ${promptsDir}`);

  logger.banner();
  logger.success(`Contracts & AI prompts injected into existing project at ${targetDir}!`);
  logger.info(`Now your AI Coding Agent can consume ${nativeContract ? nativeContract.filename : contractFileName} directly inside your module.`);
}
