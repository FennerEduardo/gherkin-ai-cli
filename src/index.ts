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
import { handleMcpCommand } from './commands/mcp';
import { handleVerifyCommand } from './commands/verify';
import { handleContextCommand } from './commands/context';
import { handleQualityCommand } from './commands/quality';
import { handleAutopilotCommand } from './commands/autopilot';
import { handleDiffCommand } from './commands/diff';
import { handleSkillCommand } from './commands/skill';
import { handleWebCommand } from './commands/web';
import { handleEvaluateCommand } from './commands/evaluate';

// Dynamic version from package.json
const pkg = require('../package.json');

const program = new Command();

program
  .name('gherkin-ai')
  .description('Enterprise-Grade Closed-Loop Agentic Orchestration Engine & Spec-Driven Verification Framework for AI Coding Agents.')
  .version(pkg.version || '2.0.0')
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
  .command('mcp [subcommand]')
  .description('Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server or auto-install config (`ghk mcp install`)')
  .option('--install', 'Auto-install MCP config into Cursor and Claude Desktop')
  .action(async (subcommand) => {
    await handleMcpCommand(subcommand);
  });

program
  .command('verify')
  .alias('v-loop')
  .description('Run closed-loop verification test harness with optional agent auto-fix and docker isolation')
  .option('--auto-fix', 'Invoke agent self-healing loop on test failure')
  .option('--docker', 'Run test suite inside isolated Docker container')
  .option('--max-retries <number>', 'Maximum auto-fix retries (default: 3)', '3')
  .option('-c, --command <cmd>', 'Custom test execution command')
  .action(async (options) => {
    await handleVerifyCommand(options);
  });

program
  .command('context [subcommand]')
  .description('Build and package project context and conventions into .ghe/')
  .action(async (subcommand) => {
    await handleContextCommand(subcommand);
  });

program
  .command('quality')
  .alias('q')
  .description('Calculate feature quality score index and enterprise gate compliance')
  .action(async () => {
    await handleQualityCommand();
  });

program
  .command('autopilot')
  .alias('auto')
  .description('Run autonomous multi-agent delivery workflow from product requirement to PR')
  .option('-r, --requirement <file>', 'Path to feature requirement file')
  .action(async (options) => {
    await handleAutopilotCommand(options);
  });

program
  .command('diff')
  .description('Run Drift Detection to ensure code DTOs match Gherkin specs')
  .option('-f, --feature <file>', 'Gherkin feature file source of truth')
  .option('-t, --target <file>', 'Target source code file (e.g. DTO or Contract)')
  .action(handleDiffCommand);

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
  .option('-C, --caveman', 'Enable simple prompt creation mode (skip step-by-step wizard)')
  .option('--headless', 'Run in headless non-interactive mode for CI/CD')
  .option('--config <file>', 'Path to JSON configuration file for headless mode')
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

program
  .command('skill')
  .alias('s')
  .description('Configure Gherkin AI as a native tool/skill for AI IDEs like Cursor and Windsurf')
  .action(async () => {
    await handleSkillCommand();
  });

program
  .command('web')
  .alias('w')
  .alias('ui')
  .description('Launch local Web UI Server to visually guide the generation process')
  .option('-p, --port <number>', 'Port to run the web server on')
  .action(async (options) => {
    await handleWebCommand(options);
  });

program
  .command('evaluate <files...>')
  .alias('eval')
  .description('Evaluate one or more files for code quality and architectural pattern compliance')
  .option('--max-file-lines <number>', 'Maximum lines allowed per file (default: 300)')
  .option('--max-class-lines <number>', 'Maximum lines allowed per class (default: 200)')
  .action(async (files, options) => {
    await handleEvaluateCommand(files, options);
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

async function bootstrap() {
  const { resolveWorkspaceDirectory } = await import('./utils/workspace-detector');
  await resolveWorkspaceDirectory();
  program.parse(process.argv);
}

bootstrap();
