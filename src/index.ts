/* ==========================================================================
   gherkin-ai-cli - Main Commander CLI Entry Point
   ========================================================================== */

import { Command } from 'commander';
import { handleInitCommand } from './commands/init';
import { handleGenerateCommand } from './commands/generate';
import { handleValidateCommand } from './commands/validate';
import { handleExportCommand } from './commands/export';

// Dynamic version from package.json
const pkg = require('../package.json');

const program = new Command();

program
  .name('gherkin-ai')
  .description('CLI tool & contract engine translating Gherkin specs into executable prompts, TypeScript contracts, and seed fixtures for AI Agents.')
  .version(pkg.version || '1.1.0');

program
  .command('init')
  .description('Initialize interactive gherkin-ai project configuration (gherkin-ai.config.json)')
  .action(async () => {
    await handleInitCommand();
  });

program
  .command('generate')
  .description('Generate TypeScript contracts, DTO schemas, test fixtures, docker-compose, and agent prompts from Gherkin feature spec')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await handleGenerateCommand(options);
  });

program
  .command('validate')
  .description('Validate Gherkin specification and architecture rules compliance')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await handleValidateCommand(options);
  });

program
  .command('export')
  .description('Export single AI Agent context bundle (Markdown or JSON)')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('--format <type>', 'Export format (json or md)', 'md')
  .option('-o, --output <file>', 'Output destination file path')
  .action(async (options) => {
    await handleExportCommand(options);
  });

program.parse(process.argv);
