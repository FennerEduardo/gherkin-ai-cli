/* ==========================================================================
   gherkin-ai-cli - 'add' Command Handler (Brownfield Contract Injector)
   ========================================================================== */

import { PolicyError, UsageError } from '../core/errors';
import { isPathInside } from '../utils/path-guard';
import path from 'path';
import inquirer from 'inquirer';
import { loadConfig } from '../core/config';
import { detectExistingStack } from '../core/stack-detector';
import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { generatePrompts } from '../generators/prompts';
import { buildSpecificationIR } from '../core/ir-builder';
import { handleCreateCommand } from './create';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import { featurePascalName } from '../utils/naming';
import { mergeArtifacts, readInventoryFile, writeInventoryFile } from '../core/inventory';
import { applyWrites, NEW_SUFFIX, planWrites, sha256 } from '../core/write-protection';
import { CLI_VERSION } from '../version';
import { promptOrFallback, t } from '../utils/i18n-cli';

export async function handleAddCommand(options: { feature?: string; target?: string; config?: string; yes?: boolean; nonInteractive?: boolean }): Promise<void> {
  logger.banner();


  if (!options.feature) {
    logger.info('No --feature file specified. Launching interactive spec wizard...');
    await handleCreateCommand({ target: options.target, yes: options.yes, nonInteractive: options.nonInteractive });
    return;
  }

  const featurePath = path.resolve(process.cwd(), options.feature);

  if (!fileExistsSync(featurePath)) {
    logger.warn(`${t('featureNotFound')} ${featurePath}`);
    
    const answer = await promptOrFallback([
      {
        type: 'confirm',
        name: 'createNow',
        message: t('askCreateInteractive'),
        default: true
      }
    ], options);

    if (answer.createNow) {
      await handleCreateCommand({ output: options.feature, target: options.target, yes: options.yes, nonInteractive: options.nonInteractive });
      return;
    } else {
      throw new UsageError(`Feature file not found: ${options.feature ?? '(none)'}`, { hint: 'Pass an existing file with --feature or create one with `ghk create`.' });
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

  const featurePascal = featurePascalName(parsed) || 'Feature';
  const language = (config.stack?.language || '').toLowerCase();
  const typescript = language === 'typescript' || language === 'javascript';
  // src/modules/<feature> is a NestJS convention; other layouts must say where the module is.
  if (!options.target && config.stack?.framework !== 'nestjs') {
    throw new UsageError('ghk add needs the module directory: --target <dir>.', { hint: `For example: ghk add -f ${options.feature} -t src/${featurePascal.toLowerCase()}` });
  }
  const cwd = process.cwd();
  const targetDir = options.target
    ? path.resolve(cwd, options.target)
    : path.resolve(cwd, 'src', 'modules', featurePascal.toLowerCase());

  if (!isPathInside(cwd, targetDir)) {
    throw new PolicyError(`Security Violation: Target path escapes the current workspace: ${targetDir}`);
  }
  logger.info(`Injecting contracts & AI prompts into: ${targetDir}`);

  // Contracts, ADR and the language-native contract; the TypeScript contract and test stubs only for TypeScript.
  const ir = buildSpecificationIR(parsed, featurePath, { domainProfile: config.domainProfile, industry: config.industry?.id });
  const { contractsTs, adrMd, openApiJson, asyncApiJson, nativeContract } = generateContracts(parsed, ir, config);
  const slug = featurePascal.toLowerCase();
  const files: [string, string][] = [
    [`${slug}.openapi.json`, openApiJson],
    [`${slug}.asyncapi.json`, asyncApiJson],
    [`ADR-${featurePascal}.md`, adrMd]
  ];
  if (typescript) {
    files.push([`${slug}.contract.ts`, contractsTs], [`__tests__/${slug}.stub.spec.ts`, pendingTests(parsed)]);
  }
  if (nativeContract) files.push([nativeContract.filename, nativeContract.content]);
  const prompts = generatePrompts(parsed, config);
  for (const name of Object.keys(prompts)) files.push([`prompts/${name}`, prompts[name]]);

  // Same protection as `ghk generate`: an edited file is kept and gets <file>.ghk-new. Paths are recorded
  // relative to outputDir, like every inventory entry, and typed 'add' so `ghk upgrade` never prunes them.
  const outputDir = config.outputDir || './';
  const outputAbs = path.resolve(cwd, outputDir);
  const artifacts = files.map(([file, content]) => ({
    filePath: path.relative(outputAbs, path.join(targetDir, file)).split(path.sep).join('/'),
    content
  }));
  const inventoryPath = path.join(cwd, '.ghe', 'inventory.json');
  const previous = readInventoryFile(inventoryPath);
  // `ghk add` is an explicit request for these files: it creates them in an implemented project too.
  const plans = planWrites(artifacts, { cwd, outputDir, inventory: previous.artifacts, protect: config.generation?.protect, exclude: config.generation?.exclude, includeScaffold: true });
  applyWrites(plans, new Map(artifacts.map(a => [a.filePath, a.content])), (file, content) => writeFileSync(file, content));
  for (const p of plans) {
    const shown = path.relative(cwd, p.fullPath);
    if (p.action === 'side-by-side') logger.warn(`[Protected] ${shown} kept (${p.reason}); new version: ${shown}${NEW_SUFFIX}`);
    else if (p.action !== 'unchanged') logger.success(`${p.action === 'create' ? 'Created' : 'Updated'}: ${shown}`);
  }
  const generatedAt = new Date().toISOString();
  const feature = path.relative(cwd, featurePath).split(path.sep).join('/');
  writeInventoryFile(inventoryPath, {
    ...previous,
    artifacts: mergeArtifacts(previous.artifacts, artifacts.map(a => ({ filePath: a.filePath, type: 'add', checksum: sha256(a.content), feature, generatedAt })))
  });
  if (!typescript) logger.info('The executable BDD steps for this stack come with `ghk generate`; `ghk add` writes contracts and prompts only.');

  logger.banner();
  logger.success(`Contracts & AI prompts injected into existing project at ${targetDir}!`);
  logger.info(`Now your AI Coding Agent can consume ${nativeContract ? nativeContract.filename : typescript ? `${slug}.contract.ts` : `${slug}.openapi.json`} directly inside your module.`);
}

/** One pending test per step (`it.todo`: reported as todo by Jest and Vitest, never as passing). */
function pendingTests(parsed: ReturnType<typeof parseGherkinText>): string {
  let text = `// Generated by gherkin-ai v${CLI_VERSION}: one pending test per step of the feature.\n\n`;
  text += `describe(${JSON.stringify(parsed.featureName)}, () => {\n`;
  for (const sc of parsed.scenarios) {
    text += `  describe(${JSON.stringify(`Scenario: ${sc.name}`)}, () => {\n`;
    for (const st of sc.steps) text += `    it.todo(${JSON.stringify(`${st.keyword} ${st.text}`)});\n`;
    text += `  });\n`;
  }
  return `${text}});\n`;
}
