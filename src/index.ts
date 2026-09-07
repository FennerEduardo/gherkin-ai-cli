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
import { handleLintCommand } from './commands/lint';
import { handleConvergeCommand } from './commands/converge';

// Dynamic version from package.json
const pkg = require('../package.json');

const program = new Command();

program
  .name('gherkin-ai')
  .description('Enterprise-Grade Closed-Loop Agentic Orchestration Engine & Spec-Driven Verification Framework for AI Coding Agents.')
  .version(pkg.version || '2.0.0')
  .option('--project <dir>', 'Target project directory (skip interactive selector)')
  .option('--yes', 'Accept all defaults without prompting (non-interactive mode)')
  .option('--non-interactive', 'Alias for --yes')
  .option('--spec-dir <dir>', 'Target specification directory (overrides config)')
  .option('--verbose', 'Enable verbose logging')
  .option('--json', 'Enable JSON output format for CI')
  .option('--init', 'Alias for init command')
  .option('--create', 'Alias for create command')
  .option('--generate', 'Alias for generate command')
  .option('--validate', 'Alias for validate command')
  .option('--detect', 'Alias for detect command')
  .option('--dry-run', 'Simulate changes without modifying filesystem (generates .patch by default)')
  .option('--stdout', 'Print dry-run patches or modifications to stdout instead of files');

program
  .command('init')
  .alias('i')
  .description('Initialize interactive gherkin-ai project configuration (gherkin-ai.config.json)')
  .option('--enterprise', 'Initialize with enterprise constitution guardrails')
  .action(async (options) => {
    await handleInitCommand(options);
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
  .option('-c, --command <cmd>', 'Custom test execution command (overrides config)')
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
  .option('--openapi <file>', 'Path to OpenAPI spec file to validate against IR')
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
    const { handleSkillCommand } = await import('./commands/skill');
    await handleSkillCommand();
  });

program
  .command('sbom')
  .description('Generate Software Bill of Materials (CycloneDX)')
  .action(async () => {
    const { handleSbomCommand } = await import('./commands/sbom');
    await handleSbomCommand();
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

program
  .command('lint')
  .description('Lint Gherkin specifications against 14+ quality and enterprise compliance rules')
  .option('-f, --feature <file>', 'Specific feature file to lint')
  .option('--json', 'Output report as JSON')
  .action(async (options) => {
    await handleLintCommand(options);
  });

program
  .command('converge')
  .alias('conv')
  .description('Measure Specification-to-Implementation alignment across 6 architectural dimensions')
  .option('-f, --feature <file>', 'Specific feature file to evaluate')
  .option('--strict', 'Fail if overall convergence is below 80%')
  .action(async (options) => {
    await handleConvergeCommand(options);
  });

program
  .command('impact')
  .description('Analyze blast radius of specification changes')
  .option('-f, --feature <file>', 'Feature file to analyze')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { handleImpactCommand } = await import('./commands/impact');
    await handleImpactCommand(options);
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
  
  // Extract global options manually before parsing because we need to know the workspace first
  const argv = process.argv;
  const projectIdx = argv.findIndex(arg => arg === '--project');
  const project = projectIdx > -1 ? argv[projectIdx + 1] : undefined;
  const nonInteractive = argv.includes('--yes') || argv.includes('--non-interactive');
  if (nonInteractive) {
    process.env.GHK_NON_INTERACTIVE = 'true';
  }
  
  const specDirIdx = argv.findIndex(arg => arg === '--spec-dir');
  if (specDirIdx > -1 && argv[specDirIdx + 1]) {
    process.env.GHK_SPEC_DIR = argv[specDirIdx + 1];
  }

  const isVerbose = argv.includes('--verbose');
  const isJson = argv.includes('--json');
  if (argv.includes('--dry-run')) process.env.GHK_DRY_RUN = 'true';
  if (argv.includes('--stdout')) process.env.GHK_STDOUT = 'true';

  const { logger } = await import('./utils/logger');
  logger.configure({ verbose: isVerbose, json: isJson });

  await resolveWorkspaceDirectory({ project, nonInteractive });
  program.parse(process.argv);
}

bootstrap();
