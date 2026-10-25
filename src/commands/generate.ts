/* ==========================================================================
   gherkin-ai-cli - 'generate' Command Handler
   ========================================================================== */

import { getStackSupport, supportWarning } from '../generators/stack-support';
import { ExitCode, GhkError } from '../core/errors';
import { getRunContext, isNonInteractive } from '../core/run-context';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { buildIR } from '../core/ir-builder';
import { pluginRegistry } from '../core/plugin-system';
import { registerCorePlugins } from '../plugins/core-generators-plugin';
import { fileExistsSync, readFileSync, writeFileSync, writeGeneratedFile } from '../utils/file-system';
import { logger } from '../utils/logger';
import { ensureGitignore } from '../utils/gitignore-manager';
import { detectMissingDependencies } from '../core/stack-setup';
import { emitJson } from '../utils/output';
import { CLI_VERSION } from '../version';
import type { ArtifactRole } from '../core/artifact-roles';
import type { WriteAction } from '../core/write-protection';
import inquirer from 'inquirer';
import chalk from 'chalk';

function buildDynamicFeatureTemplate(rawName: string): string {
  const baseName = path.basename(rawName, '.feature').replace(/^[0-9]+[-_]?/, '');
  const words = baseName.split(/[-_]/).filter(Boolean);
  const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Domain Feature';
  const pascalName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');

  return `Feature: ${title}
  As a system user or business manager
  I want to process and manage ${title.toLowerCase()} operations
  So that data integrity and business rules are enforced across the application

  Scenario: Process ${title.toLowerCase()} successfully
    Given a valid ${title.toLowerCase()} request with required payload
    When processing ${title.toLowerCase()} request
    Then the system responds with HTTP status 200 OK
    And stores record in database
    And emits a "${pascalName}Processed" domain event

  Scenario: Reject ${title.toLowerCase()} with invalid parameters
    Given an invalid ${title.toLowerCase()} request with missing fields
    When processing ${title.toLowerCase()} request
    Then the system responds with HTTP status 400 Bad Request
    And returns validation error details
`;
}

export interface GenerateCommandOptions {
  feature?: string;
  config?: string;
  yes?: boolean;
  /** Overwrite files even when they were edited or protected. */
  force?: boolean;
  /** Print what would be written, write nothing. */
  dryRun?: boolean;
  /** Also create scaffolding (controllers, wiring, tests) in a project marked as implemented. */
  includeScaffold?: boolean;
  /** Overwrite header-marked files without a checksum even when there is no inventory (`ghk upgrade --apply`). */
  trustHeaders?: boolean;
  json?: boolean;
}

/** What `ghk generate` planned for each file (also its --json output). */
export interface GenerateResult {
  feature?: string;
  dryRun: boolean;
  plan: { file: string; target: string; action: WriteAction; role: ArtifactRole; reason?: string; held?: boolean }[];
  summary: Record<WriteAction, number>;
  /** Kernel files kept as they are: the generated code waits in .ghk-new until they are merged. */
  kernelPendingMerge: string[];
}

export async function handleGenerateCommand(options: GenerateCommandOptions): Promise<GenerateResult | undefined> {
  logger.banner();

  const config = loadConfig(options.config);
  const tierWarning = supportWarning(getStackSupport(config));
  if (tierWarning) logger.warn(tierWarning);
  let gherkinText = buildDynamicFeatureTemplate('sample-feature.feature');
  const nonInteractive = isNonInteractive(options);

  if (options.feature) {
    const featurePath = path.resolve(process.cwd(), options.feature);
    if (fileExistsSync(featurePath)) {
      gherkinText = readFileSync(featurePath);
      logger.info(`Loaded existing feature specification from: ${featurePath}`);
    } else {
      const specsDir = path.dirname(featurePath);
      if (!fs.existsSync(specsDir)) {
        fs.mkdirSync(specsDir, { recursive: true });
      }

      const baseName = path.basename(options.feature, '.feature').replace(/^[0-9]+[-_]?/, '');
      const words = baseName.split(/[-_]/).filter(Boolean);
      const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') || 'Domain Feature';

      if (!nonInteractive) {
        logger.warn(`Feature file not found at ${featurePath}.`);
        const { createMode } = await inquirer.prompt([{
          type: 'list',
          name: 'createMode',
          message: `How would you like to create specification at ${options.feature}?`,
          choices: [
            { name: `1. Auto-generate Context Template based on "${title}"`, value: 'template' },
            { name: '2. Interactive Terminal Wizard (Define Actor, Action & Scenarios)', value: 'wizard' },
            { name: '3. AI Agent Assistant Mode (Generate prompt for Claude/Cursor/Antigravity to draft spec)', value: 'ai-assistant' }
          ],
          default: 'template'
        }]);

        if (createMode === 'wizard') {
          const { handleCreateCommand } = await import('./create');
          await handleCreateCommand({ output: featurePath, yes: false });
          gherkinText = readFileSync(featurePath);
        } else if (createMode === 'ai-assistant') {
          gherkinText = buildDynamicFeatureTemplate(options.feature);
          writeFileSync(featurePath, gherkinText);
          logger.success(`Created initial feature specification at: ${featurePath}`);
          
          const promptPath = path.join(config.outputDir, 'prompts', 'feature-spec-assistant.md');
          const promptDir = path.dirname(promptPath);
          if (!fs.existsSync(promptDir)) fs.mkdirSync(promptDir, { recursive: true });
          
          const assistantPrompt = `# 🤖 ROLE: GHERKIN SPECIFICATION ASSISTANT AGENT
Objective: Write detailed Gherkin feature scenarios for ${title}.

🛠️ Target Tech Stack:
- Language: ${config.stack.language} (${config.stack.framework})
- Architecture: ${config.architecture}
- Persistence: ${config.stack.orm} + ${config.stack.database}

📌 Target File: ${featurePath}

🎯 Instructions for AI Agent:
1. Open and edit ${featurePath}.
2. Implement complete Given/When/Then BDD scenarios matching business requirements.
3. Specify HTTP status codes, payload validations, and domain events.
`;
          writeFileSync(promptPath, assistantPrompt);
          logger.success(`Generated AI Assistant Prompt for Feature Drafting: ${promptPath}`);
        } else {
          gherkinText = buildDynamicFeatureTemplate(options.feature);
          writeFileSync(featurePath, gherkinText);
          logger.success(`Created feature specification from domain template: ${featurePath}`);
        }
      } else {
        gherkinText = buildDynamicFeatureTemplate(options.feature);
        writeFileSync(featurePath, gherkinText);
        logger.success(`Created feature specification from domain template: ${featurePath}`);
      }
    }
  } else {
    logger.info('No feature file specified. Using built-in sample feature spec.');
  }

  const { detectPromptInjection } = await import('../core/security-sanitizer');
  const securityCheck = detectPromptInjection(gherkinText);
  if (!securityCheck.isSafe) {
    logger.error('SECURITY ALERT: Prompt Injection Attempt Blocked!');
    logger.error(`Reason: ${securityCheck.reason}`);
    process.exitCode = ExitCode.POLICY_DENIED;
    return;
  }

  logger.info('Parsing Gherkin specification and extracting domain AST...');
  const parsed = parseGherkinText(gherkinText);

  logger.info('Building Semantic IR...');
  const ir = buildIR(parsed, options.feature || 'sample.feature', { domainProfile: config.domainProfile, industry: config.industry?.id });

  logger.info(`Target Output Directory: ${config.outputDir}`);

  // Initialize Plugin Architecture
  pluginRegistry.initialize({ config, constitution: null, projectDir: process.cwd() });
  
  // Auto-sync governance policy to reflect current config
  if (fs.existsSync(path.join(process.cwd(), '.ghkgovernance.yaml'))) {
    const { generateGovernanceConfig } = await import('./init');
    generateGovernanceConfig(config, process.cwd());
  }
  
  // Only register core plugins if not already registered (to prevent duplicate throws)
  if (pluginRegistry.getPlugins().length === 0) {
    registerCorePlugins(pluginRegistry);
  }

  console.log(chalk.bold.cyan('\n🔍 Context Confirmation for AI Agents:'));
  console.log(`- Architecture: ${config.architecture}`);
  console.log(`- Stack: ${config.stack.language} + ${config.stack.framework}`);
  console.log(`- Persistence: ${config.stack.orm} + ${config.stack.database}`);
  console.log(`- Tools: ${config.stack.testing} (Testing), ${config.stack.validation} (Validation)`);
  if (config.stack.aiEngine) {
    console.log(`- AI Tools: ${config.stack.aiEngine}`);
  }

  let confirmContext = true;
  if (!nonInteractive) {
    const answer = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmContext',
      message: 'Is this technical context correct for the agent prompts?',
      default: true
    }]);
    confirmContext = answer.confirmContext;
  }

  if (!confirmContext) {
    throw new GhkError('Context rejected.', ExitCode.GENERIC, { hint: 'Update gherkin-ai.config.json or run `ghk detect`, then run again.' });
  }

  // ── Stack Dependency Check ──────────────────────────────────────────
  const setupResult = detectMissingDependencies(config, process.cwd());
  if (setupResult.hasMissing) {
    console.log(chalk.yellow(`\n⚠ Missing ${setupResult.missing.length} stack dependency group(s) declared in config:\n`));
    for (const dep of setupResult.missing) {
      console.log(chalk.yellow(`  • ${dep.name} (${dep.category}): ${dep.reason}`));
      console.log(chalk.cyan(`    → ${dep.installCommand}`));
    }
    console.log('');

    if (nonInteractive) {
      logger.info('Run the commands above to install missing dependencies, or use `ghk init` to reconfigure.');
    } else {
      const { autoInstall } = await inquirer.prompt([{
        type: 'confirm',
        name: 'autoInstall',
        message: 'Would you like to install missing stack dependencies now?',
        default: false
      }]);

      if (autoInstall) {
        const { executeSetup } = await import('../core/stack-setup');
        const result = executeSetup(setupResult.suggestions, { cwd: process.cwd() });
        if (result.success) {
          logger.success('Stack dependencies installed successfully.');
        } else {
          logger.error(`Some installations failed: ${result.output}`);
        }
      }
    }
  }

  const agentChoices = [
    { name: 'Domain Architect Agent', value: 'domain-agent.md', checked: true },
    { name: 'Backend Developer Agent', value: 'backend-agent.md', checked: true },
    { name: 'QA Automation Agent', value: 'qa-agent.md', checked: true }
  ];
  
  if (config.stack.aiEngine) {
    agentChoices.push({ name: 'AI Engineer Agent (RAG/VectorDB)', value: 'ai-engineer-agent.md', checked: true });
  }

  let selectedAgents = agentChoices.map(c => c.value);
  if (!nonInteractive) {
    const answer = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selectedAgents',
      message: 'Which Agent Prompts do you want to generate?',
      choices: agentChoices
    }]);
    selectedAgents = answer.selectedAgents;
  }

  if (selectedAgents.length === 0) {
    logger.warn('No agents selected. Filtering out prompt generation.');
  }

  const externalPlugins = pluginRegistry.loadFromConfig(config, process.cwd());
  if (externalPlugins.length) logger.info(`Loaded plugins: ${externalPlugins.join(', ')}`);

  // Generate all artifacts via Plugin System
  logger.info('Running Generation Plugins...');
  const artifacts = pluginRegistry.runGeneration(ir, config);


  // Filter out unselected prompts
  const filteredArtifacts = artifacts.filter(a => {
    if (a.type === 'prompt') {
      const filename = path.basename(a.filePath);
      return selectedAgents.includes(filename);
    }
    return true;
  });

  // Anti-Stub Global Validation Gate
  const stubArtifacts = filteredArtifacts.filter(a => /\/\/\s*TODO:|\/\/\s*FIXME:|throw new NotImplementedException/i.test(a.content));
  if (stubArtifacts.length > 0) {
    logger.error('CRITICAL GUARDRAIL VIOLATION: Generate flow produced artifacts with placeholder code (TODO/FIXME).');
    logger.error('The following generated files contain stubs:');
    stubArtifacts.forEach(a => logger.error(` - ${a.filePath}`));
    throw new GhkError('Aborting generation to enforce clean architecture and complete implementations.', ExitCode.GATE_FAILED);
  }

  // Implemented code is never overwritten: only files whose checksum still matches what was generated
  // are updated; edited or protected files get the new version as <file>.ghk-new.
  const { readInventoryFile, writeInventoryFile, mergeArtifacts } = await import('../core/inventory');
  const { planWrites, applyWrites, kernelPendingMerge, sha256, NEW_SUFFIX, IMPLEMENTED_MARKER } = await import('../core/write-protection');
  const gheDir = path.join(process.cwd(), '.ghe');
  const inventoryPath = path.join(gheDir, 'inventory.json');
  const previous = readInventoryFile(inventoryPath);
  const plans = planWrites(filteredArtifacts, {
    cwd: process.cwd(),
    outputDir: config.outputDir,
    inventory: previous.artifacts,
    protect: config.generation?.protect,
    exclude: config.generation?.exclude,
    includeScaffold: options.includeScaffold,
    trustHeaders: options.trustHeaders,
    force: options.force
  });
  const typeOf = new Map(filteredArtifacts.map(a => [a.filePath, a.type]));
  const dryRun = Boolean(options.dryRun) || getRunContext().dryRun;
  // An explicit `json: false` wins over the global --json: `upgrade --apply --json` regenerates through this
  // function and prints its own report (stdout carries exactly one JSON document).
  const json = options.json ?? getRunContext().json;
  const pendingKernel = kernelPendingMerge(plans);
  const result: GenerateResult = {
    feature: options.feature,
    dryRun,
    plan: plans.map(p => ({
      file: p.filePath,
      target: path.relative(process.cwd(), p.target).replace(/\\/g, '/'),
      action: p.action,
      role: p.role,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.held ? { held: true } : {})
    })),
    summary: { create: 0, update: 0, unchanged: 0, overwrite: 0, 'side-by-side': 0, skipped: 0 },
    kernelPendingMerge: pendingKernel.map(p => p.filePath)
  };
  for (const p of plans) result.summary[p.action]++;

  if (dryRun) {
    console.log(chalk.bold.cyan('\n📝 Dry run: nothing is written.\n'));
    for (const p of plans) {
      console.log(`  ${p.action.padEnd(12)} ${p.filePath}${p.action === 'side-by-side' ? NEW_SUFFIX : ''}${p.reason ? chalk.gray(`  (${p.reason})`) : ''}`);
    }
    if (json) emitJson(result);
    return result;
  }

  applyWrites(plans, new Map(filteredArtifacts.map(a => [a.filePath, a.content])), writeGeneratedFile);
  for (const p of plans) {
    if (p.held) logger.warn(`[Held] ${p.filePath}: written as ${p.filePath}${NEW_SUFFIX} (${p.reason})`);
    else if (p.action === 'side-by-side') logger.warn(`[Protected] ${p.filePath} kept (${p.reason}); new version: ${p.filePath}${NEW_SUFFIX}`);
    else if (p.action === 'skipped') logger.info(`[Skipped] ${p.filePath} (${p.reason})`);
    else if (p.action === 'unchanged') logger.info(`[Plugin ${typeOf.get(p.filePath)}] Unchanged: ${p.filePath}`);
    else logger.success(`[Plugin ${typeOf.get(p.filePath)}] ${p.action === 'create' ? 'Generated' : 'Updated'}: ${p.filePath}${p.action === 'overwrite' && p.reason ? chalk.gray(` (${p.reason})`) : ''}`);
  }
  const sideBySide = plans.filter(p => p.action === 'side-by-side');
  if (sideBySide.length) {
    logger.warn(`${sideBySide.length} file(s) were not overwritten. Merge each ${NEW_SUFFIX} file into the original (or delete it), or rerun with --force to overwrite.`);
  }
  // The application layer is generated against this CLI's runtime kernel; a kept (older or edited) kernel
  // may not have what it calls (e.g. the aggregate type of a multi-feature service).
  if (pendingKernel.length) {
    const held = plans.filter(p => p.held).length;
    logger.warn(`Runtime kernel pending merge: ${pendingKernel.length} kernel file(s) kept (${pendingKernel.map(p => p.filePath).slice(0, 3).join(', ')}${pendingKernel.length > 3 ? ', ...' : ''})` +
      `${held ? `; ${held} generated source file(s) held as ${NEW_SUFFIX} so the project still compiles` : ''}. ` +
      `Merge the kernel ${NEW_SUFFIX} files first (ghk upgrade --kernel shows them), then generate again.`);
  }
  const skipped = plans.filter(p => p.action === 'skipped');
  if (skipped.length) logger.info(`${skipped.length} file(s) skipped (generation.exclude, or not created in a project marked ${IMPLEMENTED_MARKER}).`);

  // Traceability inventory: checksums of what this run generated, merged with earlier features' entries.
  const generatedAt = new Date().toISOString();
  const declinedBefore = new Map(previous.artifacts.filter(a => a.declined).map(a => [a.filePath.replace(/\\/g, '/'), a.declined]));
  const previousEntry = new Map(previous.artifacts.map(a => [a.filePath.replace(/\\/g, '/'), a]));
  const notWritten = new Map(plans.filter(p => p.action === 'skipped' || p.held).map(p => [p.filePath, p.action === 'skipped']));
  // The feature and its contracts as they are after this run: `ghk converge` reports a feature edited since
  // while its contracts were not (they still describe the previous feature).
  const featureRel = options.feature ? path.relative(process.cwd(), path.resolve(process.cwd(), options.feature)).replace(/\\/g, '/') : undefined;
  const { artifactRole } = await import('../core/artifact-roles');
  const contractsOnDisk = Object.fromEntries(plans
    .filter(p => artifactRole(p.filePath, typeOf.get(p.filePath)) === 'contract' && fs.existsSync(p.fullPath))
    .map(p => [p.filePath.replace(/\\/g, '/'), sha256(fs.readFileSync(p.fullPath).toString('utf8').replace(/\r\n/g, '\n'))]));
  writeInventoryFile(inventoryPath, {
    ...previous,
    cliVersion: CLI_VERSION,
    ...(featureRel ? { features: { ...previous.features, [featureRel]: { checksum: sha256(gherkinText.replace(/\r\n/g, '\n')), contracts: contractsOnDisk } } } : {}),
    artifacts: mergeArtifacts(previous.artifacts, filteredArtifacts.map(a => {
      // Skipped, or held as .ghk-new: the file on disk did not change, so keep what was on record (its checksum
      // still proves an untouched file). It counts as generated by this run: `ghk upgrade` does not prune it.
      if (notWritten.has(a.filePath)) {
        return { ...previousEntry.get(a.filePath.replace(/\\/g, '/')), filePath: a.filePath, type: a.type, generatedAt, ...(notWritten.get(a.filePath) ? { skipped: true } : {}) };
      }
      const checksum = sha256(a.content);
      // A version declined in `ghk generate --review` stays declined while the generator produces the same content.
      const declined = declinedBefore.get(a.filePath.replace(/\\/g, '/')) === checksum ? checksum : undefined;
      return {
        filePath: a.filePath,
        type: a.type,
        checksum,
        feature: featureRel,
        generatedAt,
        ...(declined ? { declined } : {})
      };
    }))
  });
  logger.success(`[Audit] Traceability inventory saved to .ghe/inventory.json`);

  // Industry rules for agents and reviewers (.ghe is CLI state: not tracked by the inventory).
  const { writeIndustryContext, INDUSTRY_CONTEXT_MD } = await import('../core/profiles/industries/context-files');
  const industry = writeIndustryContext(process.cwd(), config);
  if (industry) logger.success(`[Industry] ${industry.label} rules saved to ${INDUSTRY_CONTEXT_MD}`);
  const { writeDeploymentContext, DEPLOYMENT_CONTEXT_MD } = await import('../generators/deploy/context');
  if (writeDeploymentContext(process.cwd(), config)) logger.success(`[Deploy] Deployment readiness rules saved to ${DEPLOYMENT_CONTEXT_MD}`);

  // Generate Suggested Commit Message
  const suggestedCommit = `feat: Implement ${parsed.featureName} base architecture

This commit implements the foundation for ${parsed.featureName} based on Gherkin specifications.

Generated Artifacts:
${filteredArtifacts.map(a => `- ${a.filePath}`).join('\n')}

Validation:
- Anti-Stub validation: Passed
- Gherkin Coverage: ${parsed.scenarios.length} scenarios mapped
- CQRS/DDD Contracts: Generated

Next Steps:
- Run 'docker compose up -d' or use the provided test infrastructure to validate integrations.
`;
  writeFileSync(path.join(gheDir, 'suggested_commit.md'), suggestedCommit);
  logger.info(`[Git] Suggested commit message written to .ghe/suggested_commit.md`);

  logger.banner();
  ensureGitignore(process.cwd());
  logger.success(`All artifacts successfully generated under ${config.outputDir}!`);
  logger.info('Ready for AI Agents (Claude Code, Cursor, Antigravity, Copilot).');
  if (json) emitJson(result);
  return result;
}
