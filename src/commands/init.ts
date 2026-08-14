/* ==========================================================================
   gherkin-ai-cli - 'init' Command Handler (Interactive CLI Wizard)
   ========================================================================== */

import inquirer from 'inquirer';
import { defaultConfig, saveConfig, GherkinAIConfig } from '../core/config';
import { logger } from '../utils/logger';

export async function handleInitCommand(): Promise<void> {
  logger.banner();
  logger.info('Initializing new gherkin-ai project configuration...');

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'What is your project name?',
      default: defaultConfig.projectName
    },
    {
      type: 'list',
      name: 'architecture',
      message: 'Select primary software architecture:',
      choices: [
        { name: 'Hexagonal Architecture (Ports & Adapters)', value: 'hexagonal' },
        { name: 'Domain-Driven Design (DDD)', value: 'ddd' },
        { name: 'Clean Architecture', value: 'clean' },
        { name: 'CQRS + Event Sourcing', value: 'cqrs' },
        { name: 'Microservices Architecture', value: 'microservices' }
      ],
      default: 'hexagonal'
    },
    {
      type: 'list',
      name: 'language',
      message: 'Select programming language / runtime:',
      choices: ['typescript', 'javascript', 'python', 'java', 'csharp', 'go'],
      default: 'typescript'
    },
    {
      type: 'list',
      name: 'framework',
      message: 'Select primary framework:',
      choices: ['nestjs', 'express', 'fastify', 'spring-boot', 'fastapi', 'aspnet'],
      default: 'nestjs'
    },
    {
      type: 'list',
      name: 'orm',
      message: 'Select database ORM / persistence:',
      choices: ['prisma', 'drizzle', 'typeorm', 'sqlalchemy'],
      default: 'prisma'
    },
    {
      type: 'list',
      name: 'database',
      message: 'Select primary database engine:',
      choices: ['postgresql', 'mysql', 'mongodb', 'redis'],
      default: 'postgresql'
    },
    {
      type: 'input',
      name: 'outputDir',
      message: 'Specify directory for generated contracts and prompts:',
      default: './generated-specs'
    }
  ]);

  const newConfig: GherkinAIConfig = {
    projectName: answers.projectName,
    architecture: answers.architecture,
    stack: {
      language: answers.language,
      framework: answers.framework,
      orm: answers.orm,
      database: answers.database,
      validation: 'zod',
      auth: 'jwt-bcrypt',
      messaging: 'rabbitmq',
      testing: 'jest'
    },
    rules: defaultConfig.rules,
    outputDir: answers.outputDir
  };

  saveConfig(newConfig);
  logger.success('Successfully created gherkin-ai.config.json');
  logger.info('Next step: Run "npx gherkin-ai generate --feature ./your-feature.feature"');
}
