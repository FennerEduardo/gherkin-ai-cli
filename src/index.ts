/* ==========================================================================
   gherkin-ai-cli - Main Commander CLI Entry Point
   ========================================================================== */

import { Command } from 'commander';
import { handleInitCommand } from './commands/init';
import { handleGenerateCommand } from './commands/generate';
import { handleValidateCommand } from './commands/validate';
import { handleExportCommand } from './commands/export';
import { handleDetectCommand } from './commands/detect';
import { handleAddCommand } from './commands/add';
import { handleCreateCommand } from './commands/create';
import { handleLangCommand } from './commands/lang';

// Dynamic version from package.json
const pkg = require('../package.json');

const program = new Command();

program
  .name('gherkin-ai')
  .description('CLI tool & contract engine translating Gherkin specs into executable prompts, TypeScript contracts, and seed fixtures for AI Agents.')
  .version(pkg.version || '1.4.0')
  .option('--init', 'Alias for init command')
  .option('--create', 'Alias for create command')
  .option('--generate', 'Alias for generate command')
  .option('--validate', 'Alias for validate command')
  .option('--detect', 'Alias for detect command');

program
  .command('init')
  .alias('i')
  .description('Initialize interactive gherkin-ai project configuration (gherkin-ai.config.json)')
  .action(async () => {
    await handleInitCommand();
  });

program
  .command('lang')
  .alias('l')
  .alias('language')
  .description('Configure CLI preferred interaction language (English or Spanish)')
  .option('-s, --set <locale>', 'Set language directly (en or es)')
  .action(async (options) => {
    await handleLangCommand(options);
  });

program
  .command('create')
  .alias('c')
  .alias('new')
  .description('Create a Gherkin feature specification interactively step-by-step from the terminal')
  .option('-o, --output <file>', 'Output destination for .feature file')
  .option('-t, --target <directory>', 'Target directory to inject contracts')
  .option('-l, --lang <locale>', 'Override CLI interaction language for this run (en or es)')
  .action(async (options) => {
    await handleCreateCommand(options);
  });

program
  .command('detect')
  .alias('d')
  .description('Auto-detect tech stack & architecture of an existing project (Brownfield mode)')
  .action(async () => {
    await handleDetectCommand();
  });

program
  .command('add')
  .alias('a')
  .description('Inject contracts & AI agent prompts into an existing project module (Brownfield mode)')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-t, --target <directory>', 'Target directory inside existing project')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await handleAddCommand(options);
  });

program
  .command('generate')
  .alias('g')
  .description('Generate TypeScript contracts, DTO schemas, test fixtures, docker-compose, and agent prompts from Gherkin feature spec')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await handleGenerateCommand(options);
  });

program
  .command('validate')
  .alias('v')
  .description('Validate Gherkin specification and architecture rules compliance')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await handleValidateCommand(options);
  });

program
  .command('export')
  .alias('e')
  .description('Export single AI Agent context bundle (Markdown or JSON)')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('--format <type>', 'Export format (json or md)', 'md')
  .option('-o, --output <file>', 'Output destination file path')
  .action(async (options) => {
    await handleExportCommand(options);
  });

// Action fallback for root flags (--init, --create, --generate, --validate, --detect)
program.action(async (options) => {
  if (options.init) {
    await handleInitCommand();
  } else if (options.create) {
    await handleCreateCommand({});
  } else if (options.detect) {
    await handleDetectCommand();
  } else if (options.generate) {
    await handleGenerateCommand({});
  } else if (options.validate) {
    await handleValidateCommand({});
  } else {
    program.help();
  }
});

program.parse(process.argv);
