/* ==========================================================================
   gherkin-ai-cli - 'generate' Command Handler
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { parseGherkinText } from '../core/gherkin-parser';
import { generateContracts } from '../generators/contracts';
import { generateFixtures } from '../generators/fixtures';
import { generatePrompts } from '../generators/prompts';
import { generateInfra } from '../generators/infra';
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

export async function handleGenerateCommand(options: { feature?: string; config?: string }): Promise<void> {
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

  logger.info('Parsing Gherkin specification and extracting domain AST...');
  const parsed = parseGherkinText(gherkinText);

  logger.info(`Target Output Directory: ${config.outputDir}`);

  // 1. Generate Contracts, ADR & OpenAPI
  const { contractsTs, adrMd, openApiJson } = generateContracts(parsed, config);
  writeFileSync(path.join(config.outputDir, 'contracts.ts'), contractsTs);
  writeFileSync(path.join(config.outputDir, 'ADR-001-architecture-decisions.md'), adrMd);
  writeFileSync(path.join(config.outputDir, 'openapi.json'), openApiJson);
  logger.success('Generated contracts.ts, ADR-001-architecture-decisions.md and openapi.json');

  // 2. Generate Test Fixtures & Seeds
  const { fixturesTs, seedSql } = generateFixtures(parsed, config);
  writeFileSync(path.join(config.outputDir, 'fixtures.ts'), fixturesTs);
  writeFileSync(path.join(config.outputDir, 'seed.sql'), seedSql);
  logger.success('Generated fixtures.ts and seed.sql');

  console.log(chalk.bold.cyan('\n🔍 Context Confirmation for AI Agents:'));
  console.log(`- Architecture: ${config.architecture}`);
  console.log(`- Stack: ${config.stack.language} + ${config.stack.framework}`);
  console.log(`- Persistence: ${config.stack.orm} + ${config.stack.database}`);
  console.log(`- Tools: ${config.stack.testing} (Testing), ${config.stack.validation} (Validation)`);
  if (config.stack.aiEngine) {
    console.log(`- AI Tools: ${config.stack.aiEngine}`);
  }

  const { confirmContext } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmContext',
    message: 'Is this technical context correct for the agent prompts?',
    default: true
  }]);

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

  const { selectedAgents } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selectedAgents',
    message: 'Which Agent Prompts do you want to generate?',
    choices: agentChoices
  }]);

  if (selectedAgents.length > 0) {
    // 3. Generate Agent Prompts
    const prompts = generatePrompts(parsed, config);
    selectedAgents.forEach((filename: string) => {
      if (prompts[filename]) {
        writeFileSync(path.join(config.outputDir, 'prompts', filename), prompts[filename]);
      }
    });
    logger.success(`Generated selected prompts in prompts/: ${selectedAgents.join(', ')}`);
  } else {
    logger.warn('No agents selected. Skipping prompt generation.');
  }

  // 4. Generate Infrastructure Config
  const { dockerComposeYaml, serverlessYml, envExample } = generateInfra(config);
  if (config.architecture === 'serverless') {
    writeFileSync(path.join(config.outputDir, 'serverless.yml'), serverlessYml);
    logger.success('Generated serverless.yml (AWS Lambda FaaS)');
  } else {
    writeFileSync(path.join(config.outputDir, 'docker-compose.yml'), dockerComposeYaml);
    logger.success('Generated docker-compose.yml');
  }
  writeFileSync(path.join(config.outputDir, '.env.example'), envExample);
  logger.success('Generated .env.example');

  logger.banner();
  logger.success(`All artifacts successfully generated under ${config.outputDir}!`);
  logger.info('Ready for AI Agents (Claude Code, Cursor, Antigravity, Copilot).');
}
