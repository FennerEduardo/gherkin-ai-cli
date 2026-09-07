/* ==========================================================================
   gherkin-ai-cli - 'generate' Command Handler
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { buildIR } from '../core/ir-builder';
import { pluginRegistry } from '../core/plugin-system';
import { registerCorePlugins } from '../plugins/core-generators-plugin';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';
import { logger } from '../utils/logger';
import inquirer from 'inquirer';
import chalk from 'chalk';

const DEFAULT_SAMPLE_GHERKIN = `Feature: User Authentication & Token Issuance
  As a registered user
  I want to authenticate using valid credentials
  So that I obtain a JWT token to access protected APIs

  Scenario: Successful login with valid credentials
    Given a registered user exists with email "dev@example.com" and password "Pass123!"
    When sending an authentication request with email "dev@example.com" and password "Pass123!"
    Then the system responds with HTTP status 200 OK
    And returns a short-lived access JWT token
    And emits a "UserAuthenticated" domain event

  Scenario: Rejected login with wrong password
    Given a registered user exists with email "dev@example.com"
    When sending an authentication request with wrong password "WrongPass"
    Then the system responds with HTTP status 401 Unauthorized
    And returns error message "Invalid credentials"
`;

export async function handleGenerateCommand(options: { feature?: string; config?: string; yes?: boolean }): Promise<void> {
  logger.banner();

  const config = loadConfig(options.config);
  let gherkinText = DEFAULT_SAMPLE_GHERKIN;

  if (options.feature) {
    const featurePath = path.resolve(process.cwd(), options.feature);
    if (fileExistsSync(featurePath)) {
      gherkinText = readFileSync(featurePath);
      logger.info(`Loaded feature specification from: ${featurePath}`);
    } else {
      logger.warn(`Feature file not found at ${featurePath}. Using default sample feature.`);
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
  const ir = buildIR(parsed, options.feature || 'sample.feature');

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

  const isNonInteractive = options.yes || process.env.GHK_NON_INTERACTIVE === 'true' || !!process.env.CI;
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

  const fs = require('fs');
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
  logger.success(`All artifacts successfully generated under ${config.outputDir}!`);
  logger.info('Ready for AI Agents (Claude Code, Cursor, Antigravity, Copilot).');
}
