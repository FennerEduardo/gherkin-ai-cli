/* ==========================================================================
   gherkin-ai-cli - 'generate' Command Handler
   ========================================================================== */

import path from 'path';
import fs from 'fs';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { buildIR } from '../core/ir-builder';
import { pluginRegistry } from '../core/plugin-system';
import { registerCorePlugins } from '../plugins/core-generators-plugin';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import { ensureGitignore } from '../utils/gitignore-manager';
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

export async function handleGenerateCommand(options: { feature?: string; config?: string; yes?: boolean }): Promise<void> {
  logger.banner();

  const config = loadConfig(options.config);
  let gherkinText = buildDynamicFeatureTemplate('sample-feature.feature');
  const isNonInteractive = options.yes || process.env.GHK_NON_INTERACTIVE === 'true' || !!process.env.CI;

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

      if (!isNonInteractive) {
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
          const { handleCreateCommand } = require('./create');
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

  const { detectPromptInjection } = require('../core/security-sanitizer');
  const securityCheck = detectPromptInjection(gherkinText);
  if (!securityCheck.isSafe) {
    logger.error('SECURITY ALERT: Prompt Injection Attempt Blocked!');
    logger.error(`Reason: ${securityCheck.reason}`);
    process.exitCode = 1;
    return;
  }

  logger.info('Parsing Gherkin specification and extracting domain AST...');
  const parsed = parseGherkinText(gherkinText);

  logger.info('Building Semantic IR...');
  const ir = buildIR(parsed, options.feature || 'sample.feature', { domainProfile: config.domainProfile });

  logger.info(`Target Output Directory: ${config.outputDir}`);

  // Initialize Plugin Architecture
  pluginRegistry.initialize({ config, constitution: null, projectDir: process.cwd() });
  
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
  if (!isNonInteractive) {
    const answer = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmContext',
      message: 'Is this technical context correct for the agent prompts?',
      default: true
    }]);
    confirmContext = answer.confirmContext;
  }

  if (!confirmContext) {
    logger.warn('Context rejected. Please update gherkin-ai.config.json or run `ghk detect` and run again.');
    process.exit(1);
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
  if (!isNonInteractive) {
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

  filteredArtifacts.forEach(artifact => {
    const fullPath = path.join(config.outputDir, artifact.filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, artifact.content);
    logger.success(`[Plugin ${artifact.type}] Generated: ${artifact.filePath}`);
  });

  logger.banner();
  ensureGitignore(process.cwd());
  logger.success(`All artifacts successfully generated under ${config.outputDir}!`);
  logger.info('Ready for AI Agents (Claude Code, Cursor, Antigravity, Copilot).');
}
