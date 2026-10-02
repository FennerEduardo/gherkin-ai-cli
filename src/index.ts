/* ==========================================================================
   gherkin-ai-cli - Main Commander CLI Entry Point
   ========================================================================== */

import { Command, CommanderError } from 'commander';
import { ExitCode, GhkError, UsageError, toGhkError } from './core/errors';
import { getRunContext, isNonInteractive, setRunContext } from './core/run-context';
import { logger } from './utils/logger';
import { configureTelemetry, getTelemetry, EXECUTION_ID } from './core/telemetry';
import { onLLMUsage } from './core/llm';
import { emitJson, enterJsonMode, hasEmittedOutput } from './utils/output';

// Version from package.json (single source of truth)
import { CLI_VERSION } from './version';

const program = new Command();
// Throw instead of calling process.exit so main() owns exit codes. Must run before subcommands are created.
program.exitOverride();

program
  .name('gherkin-ai')
  .description('Spec-driven verification, governance and prompt generation for AI coding agents.')
  .version(CLI_VERSION)
  .option('--project <dir>', 'Target project directory (skip interactive selector)')
  .option('--yes', 'Accept all defaults without prompting (non-interactive mode)')
  .option('--non-interactive', 'Alias for --yes')
  .option('--spec-dir <dir>', 'Target specification directory (overrides config)')
  .option('--verbose', 'Enable verbose logging')
  .option('--quiet', 'Only print warnings and errors')
  .option('--json', 'Machine-readable JSON on stdout (logs go to stderr)')
  .option('--init', 'Alias for init command')
  .option('--create', 'Alias for create command')
  .option('--generate', 'Alias for generate command')
  .option('--validate', 'Alias for validate command')
  .option('--detect', 'Alias for detect command')
  .option('--dry-run', 'Simulate changes without modifying filesystem (generates .patch by default)')
  .option('--stdout', 'Print dry-run patches or modifications to stdout instead of files');

program
  .command('config [subcommand]')
  .description('Inspect the resolved configuration: show (default) | validate | schema')
  .option('-c, --config <file>', 'Path to project gherkin-ai.config.json')
  .option('--sources', 'Show which layer (organization, user, project, environment) provided each value')
  .option('--json', 'Output as JSON')
  .action(async (subcommand, options) => {
    const { handleConfigCommand } = await import('./commands/config');
    await handleConfigCommand(subcommand, { ...options, json: options.json || program.opts().json });
  });

program
  .command('stacks')
  .description('List supported stacks and their support tier (stable / beta / experimental)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { STACK_SUPPORT } = await import('./generators/stack-support');
    if (options.json) {
      emitJson(STACK_SUPPORT);
      return;
    }
    for (const s of STACK_SUPPORT) logger.info(`${s.tier.padEnd(13)} ${s.label}${s.notes ? `  — ${s.notes}` : ''}`);
  });

program
  .command('login')
  .description('Select the LLM provider and store its API key in the OS keychain (never on disk)')
  .option('--provider <name>', 'openai | openai-compatible | azure-openai | anthropic | bedrock | gemini | vertex | ollama | ide_delegate')
  .option('--api-key-stdin', 'Read the API key from standard input (non-interactive)')
  .action(async (options) => {
    await (await import('./commands/login')).handleLoginCommand(options);
  });

program
  .command('logout')
  .description('Remove API keys stored in the OS keychain')
  .option('--provider <name>', 'Only remove the key for this provider')
  .action(async (options) => {
    const { handleLogoutCommand } = await import('./commands/login');
    await handleLogoutCommand(options);
  });

program
  .command('auth [subcommand]')
  .description('Show the effective LLM provider, model, credential source and network settings (`ghk auth status`)')
  .option('--json', 'Output as JSON')
  .action(async (subcommand) => {
    if (subcommand && subcommand !== 'status') throw new UsageError(`Unknown auth subcommand "${subcommand}".`, { hint: 'Use `ghk auth status`.' });
    const { handleAuthStatusCommand } = await import('./commands/login');
    await handleAuthStatusCommand();
  });

program
  .command('init')

  .alias('i')
  .description('Initialize interactive gherkin-ai project configuration (gherkin-ai.config.json)')
  .option('--enterprise', 'Initialize with enterprise constitution guardrails')
  .option('-p, --projectName <name>', 'Project name')
  .option('-a, --architecture <arch>', 'Primary software architecture')
  .option('-l, --language <lang>', 'Programming language / runtime')
  .option('-f, --framework <framework>', 'Primary framework')
  .option('-o, --orm <orm>', 'Database ORM / persistence')
  .option('-d, --database <db>', 'Database engine')
  .option('-v, --validation <lib>', 'Validation library')
  .option('-m, --messaging <broker>', 'Event broker / messaging')
  .option('-t, --testing <testing>', 'Testing framework')
  .option('--frontendFramework <framework>', 'Frontend Framework / Library')
  .option('--frontendLanguage <lang>', 'Frontend Language')
  .option('--frontendBundler <bundler>', 'Frontend Bundler')
  .option('--frontendUnitTesting <testing>', 'Frontend Unit Testing Framework')
  .option('--frontendE2eTesting <testing>', 'Frontend E2E Testing Framework')
  .option('--outputDir <dir>', 'Output directory for generated contracts')
  .action(async (options) => {
    await (await import('./commands/init')).handleInitCommand(options);
  });

program
  .command('mcp [subcommand]')
  .description('Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server or auto-install config (`ghk mcp install`)')
  .option('--install', 'Auto-install MCP config into Cursor and Claude Desktop')
  .action(async (subcommand, options) => {
    await (await import('./commands/mcp')).handleMcpCommand(subcommand, options);
  });

program
  .command('verify')
  .alias('v-loop')
  .description('Run closed-loop verification test harness (dry-run by default) with optional agent auto-fix and docker isolation')
  .option('--auto-fix', 'Invoke agent self-healing loop on test failure')
  .option('--apply', 'Apply agent self-healing code modifications to filesystem (disables dry-run)')
  .option('--docker', 'Run test suite inside isolated Docker container')
  .option('--isolated', 'Generate docker-compose on the fly to spin up isolated DB/Brokers (Testcontainers mode)')
  .option('--max-retries <number>', 'Maximum auto-fix retries (default: 3)', '3')
  .option('-c, --command <cmd>', 'Custom test execution command')
  .option('--allow-unattended-writes', 'Allow --apply in CI (otherwise refused; see policy.allowUnattendedWrites)')
  .option('--force-branch', 'Allow --apply on a protected branch (main/master by default)')
  .action(async (options) => {
    // If --apply is not passed, force dry run
    if (!options.apply) {
      process.env.GHK_DRY_RUN = 'true';
    }
    await (await import('./commands/verify')).handleVerifyCommand(options);
  });

program
  .command('context [subcommand]')
  .description('Build and package project context and conventions into .ghe/')
  .action(async (subcommand) => {
    await (await import('./commands/context')).handleContextCommand(subcommand);
  });

program
  .command('quality')
  .alias('q')
  .description('Calculate feature quality score index and enterprise gate compliance')
  .action(async () => {
    await (await import('./commands/quality')).handleQualityCommand();
  });

program
  .command('autopilot')
  .alias('auto')
  .description('Run autonomous multi-agent delivery workflow from product requirement to PR')
  .option('-r, --requirement <file>', 'Path to feature requirement file')
  .option('-c, --command <cmd>', 'Custom test execution command (overrides config)')
  .option('--apply', 'Write generated code to disk (default: dry-run .patch files)')
  .option('--allow-unattended-writes', 'Allow --apply in CI (otherwise refused; see policy.allowUnattendedWrites)')
  .option('--force-branch', 'Allow --apply on a protected branch (main/master by default)')
  .action(async (options) => {
    // Like verify, autopilot only writes LLM output to disk with an explicit --apply.
    if (!options.apply) process.env.GHK_DRY_RUN = 'true';
    await (await import('./commands/autopilot')).handleAutopilotCommand(options);
  });

program
  .command('diff')
  .description('Run Drift Detection to ensure code DTOs match Gherkin specs')
  .option('-f, --feature <file>', 'Gherkin feature file source of truth')
  .option('-t, --target <file>', 'Target source code file (e.g. DTO or Contract)')
  .action(async (options) => {
    await (await import('./commands/diff')).handleDiffCommand(options);
  });

program
  .command('lang')
  .alias('l')
  .alias('language')
  .description('Configure CLI preferred interaction language (English or Spanish)')
  .option('-s, --set <locale>', 'Set language directly (en or es)')
  .action(async (options) => {
    await (await import('./commands/lang')).handleLangCommand(options);
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
  .option('-n, --featureName <name>', 'Feature name')
  .option('-a, --actor <actor>', 'Feature actor (As a...)')
  .option('-A, --action <action>', 'Feature action (I want to...)')
  .option('-S, --scenarioName <name>', 'Scenario name')
  .action(async (options) => {
    await (await import('./commands/create')).handleCreateCommand(options);
  });


program
  .command('detect')
  .alias('d')
  .description('Auto-detect tech stack & architecture of an existing project (Brownfield mode)')
  .action(async () => {
    await (await import('./commands/detect')).handleDetectCommand();
  });

program
  .command('add')
  .alias('a')
  .description('Inject contracts & AI agent prompts into an existing project module (Brownfield mode)')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-t, --target <directory>', 'Target directory inside existing project')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await (await import('./commands/add')).handleAddCommand(options);
  });

program
  .command('generate')
  .alias('g')
  .description('Generate TypeScript contracts, DTO schemas, test fixtures, docker-compose, and agent prompts from Gherkin feature spec')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .action(async (options) => {
    await (await import('./commands/generate')).handleGenerateCommand(options);
  });

program
  .command('validate')
  .alias('v')
  .description('Validate Gherkin specification and architecture rules compliance')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
  .option('--openapi <file>', 'Path to OpenAPI spec file to validate against IR')
  .option('--asyncapi <file>', 'Path to AsyncAPI spec file to validate against IR')
  .action(async (options) => {
    await (await import('./commands/validate')).handleValidateCommand(options);
  });

program
  .command('export')
  .alias('e')
  .description('Export single AI Agent context bundle (Markdown or JSON)')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('--format <type>', 'Export format (json or md)', 'md')
  .option('-o, --output <file>', 'Output destination file path')
  .action(async (options) => {
    await (await import('./commands/export')).handleExportCommand(options);
  });

program
  .command('skill')
  .alias('s')
  .description('Configure Gherkin AI as a native tool/skill for AI IDEs like Cursor and Windsurf')
  .action(async () => {
    const { handleSkillCommand } = await import('./commands/skill');
    await (await import('./commands/skill')).handleSkillCommand();
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
    await (await import('./commands/web')).handleWebCommand(options);
  });

program
  .command('evaluate <files...>')
  .alias('eval')
  .description('Evaluate one or more files for code quality and architectural pattern compliance')
  .option('--max-file-lines <number>', 'Maximum lines allowed per file (default: 300)')
  .option('--max-class-lines <number>', 'Maximum lines allowed per class (default: 200)')
  .action(async (files, options) => {
    await (await import('./commands/evaluate')).handleEvaluateCommand(files, options);
  });

program
  .command('lint')
  .description('Lint Gherkin specifications against 14+ quality and enterprise compliance rules')
  .option('-f, --feature <file>', 'Specific feature file to lint')
  .option('--threshold <score>', 'Minimum passing score 0-100 (default: 70); below it exits with code 4')
  .option('--rules', 'List available lint rules')
  .option('--json', 'Output report as JSON')
  .action(async (options) => {
    await (await import('./commands/lint')).handleLintCommand(options);
  });

program
  .command('converge')
  .alias('conv')
  .description('Measure Specification-to-Implementation alignment across 6 architectural dimensions')
  .option('-f, --feature <file>', 'Specific feature file to evaluate')
  .option('--threshold <score>', 'Minimum convergence 0-100 (default: 80); below it exits with code 7')
  .option('--strict', 'Deprecated: the threshold is always enforced')
  .option('--json', 'Output report as JSON')
  .action(async (options) => {
    await (await import('./commands/converge')).handleConvergeCommand(options);
  });

program
  .command('implement')
  .alias('impl')
  .description('Generate AI Agent Master Implementation Prompt & context package for a feature')
  .option('-f, --feature <file>', 'Path to Gherkin .feature file')
  .option('--docker', 'Include Docker container sandbox execution instructions in master prompt')
  .option('--inventory', 'Display feature implementation & prompt execution audit trail history')
  .option('--history', 'Alias for --inventory')
  .option('--no-audit', 'Disable feature execution audit trail tracking for this run')
  .option('-C, --compact', 'Generate ultra-compact prompt with minimal token footprint for low-cost models')
  .action(async (options) => {
    await (await import('./commands/implement')).handleImplementCommand(options);
  });

program
  .command('audit [subcommand]')
  .alias('inventory')
  .alias('inv')
  .alias('history')
  .description('View the feature inventory, or `ghk audit export` the security audit trail (JSONL/CSV) for a SIEM')
  .option('-f, --feature <file>', 'Filter audit trail by feature spec or name')
  .option('--json', 'Output audit records as JSON for CI/CD pipelines')
  .option('--html', 'Generate an HTML compliance report')
  .option('--clear', 'Clear/purge the feature inventory (the action itself is audited)')
  .option('--format <format>', 'export: jsonl (default) or csv')
  .option('--since <when>', 'export: ISO date or window such as 24h, 7d')
  .option('-o, --output <file>', 'export: write to a file instead of stdout')
  .action(async (subcommand, options) => {
    if (subcommand === 'export') {
      const { handleAuditExportCommand } = await import('./commands/audit-export');
      await handleAuditExportCommand(options);
      return;
    }
    if (subcommand) throw new UsageError(`Unknown audit subcommand "${subcommand}".`, { hint: 'Use `ghk audit` or `ghk audit export`.' });
    await (await import('./commands/audit')).handleAuditCommand(options);
  });

program
  .command('agent-log')
  .description('Record or view actions executed by AI Agents during feature implementation')
  .option('-a, --action <string>', 'Describe the concrete action taken by the AI Agent')
  .option('-f, --feature <string>', 'Link action to a specific feature name or hash')
  .option('-l, --list', 'List all agent actions as a walkthrough')
  .option('--json', 'Output agent logs as JSON')
  .option('--clear', 'Clear agent action logs')
  .action(async (options) => {
    await (await import('./commands/agent-log')).handleAgentLogCommand(options);
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

program
  .command('doc')
  .alias('site')
  .description('Generate Living Documentation (Static Site) from Gherkin specifications')
  .action(async () => {
    const { handleDocCommand } = await import('./commands/doc');
    await handleDocCommand();
  });

program
  .command('pr-review')
  .description('AI Code Reviewer for Pull Requests checking architectural drift')
  .option('-f, --feature <file>', 'Feature file to validate the PR against')
  .option('--diff <file>', 'Path to git patch/diff file (defaults to stdin)')
  .action(async (options) => {
    const { handlePrReviewCommand } = await import('./commands/pr-review');
    await handlePrReviewCommand(options);
  });

// Action fallback for root flags (--init, --create, --generate, --validate, --detect)
program.action(async (options) => {
  if (options.init) {
    await (await import('./commands/init')).handleInitCommand();
  } else if (options.create) {
    await (await import('./commands/create')).handleCreateCommand({});
  } else if (options.detect) {
    await (await import('./commands/detect')).handleDetectCommand();
  } else if (options.generate) {
    await (await import('./commands/generate')).handleGenerateCommand({});
  } else if (options.validate) {
    await (await import('./commands/validate')).handleValidateCommand({});
  } else {
    program.help();
  }
});

/** Commands that must not trigger workspace detection (it may prompt or change directory). */
const WORKSPACE_FREE_COMMANDS = new Set(['config', 'stacks', 'login', 'logout', 'auth', 'lang', 'mcp', 'web']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const globals = program.opts();
  const commandName = actionCommand === program ? 'root' : actionCommand.name();
  const local = actionCommand === program ? {} : actionCommand.opts();
  const json = Boolean(globals.json || local.json);

  setRunContext({
    command: commandName,
    nonInteractive: Boolean(globals.yes || globals.nonInteractive),
    json,
    dryRun: Boolean(globals.dryRun),
    stdout: Boolean(globals.stdout),
    verbose: Boolean(globals.verbose),
    quiet: Boolean(globals.quiet)
  });
  // Legacy env flags still read by some handlers.
  if (globals.yes || globals.nonInteractive) process.env.GHK_NON_INTERACTIVE = 'true';
  if (globals.specDir) process.env.GHK_SPEC_DIR = globals.specDir;
  if (globals.dryRun) process.env.GHK_DRY_RUN = 'true';
  if (globals.stdout) process.env.GHK_STDOUT = 'true';

  logger.configure({ verbose: globals.verbose, quiet: globals.quiet, json });
  if (json) {
    // Commands read options.json; make the global flag and the local one equivalent.
    if (actionCommand !== program) actionCommand.setOptionValue('json', true);
    enterJsonMode();
  }

  if (!WORKSPACE_FREE_COMMANDS.has(commandName)) {
    const { resolveWorkspaceDirectory } = await import('./utils/workspace-detector');
    await resolveWorkspaceDirectory({
      project: globals.project,
      nonInteractive: isNonInteractive(),
      createIfMissing: commandName === 'init'
    });
  }

  // Apply logging, network and telemetry settings from the resolved config
  // (best effort: an invalid config surfaces as ConfigError from the command that loads it).
  try {
    const { loadResolvedConfig } = await import('./core/config');
    const { config, warnings } = loadResolvedConfig();
    logger.configure({
      verbose: globals.verbose,
      quiet: globals.quiet,
      json,
      level: globals.verbose || globals.quiet ? undefined : config.logging?.level,
      file: config.logging?.file,
      maxSizeMb: config.logging?.maxSizeMb,
      maxFiles: config.logging?.maxFiles,
      executionId: EXECUTION_ID
    });
    for (const warning of warnings) logger.verbose(warning);
    if (config.network?.proxy || config.network?.caFile || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
      (await import('./core/net')).configureNetwork(config.network);
    }
    configureTelemetry(process.cwd(), { dir: config.telemetry?.dir, telemetryEnabled: config.telemetry?.enabled, auditEnabled: config.audit?.enabled });
  } catch (err) {
    if (err instanceof GhkError && err.exitCode === ExitCode.CONFIG && commandName !== 'config') throw err;
  }
});

// Every LLM call is recorded locally (telemetry + audit), whichever command triggered it.
onLLMUsage(event => {
  const telemetry = getTelemetry();
  telemetry.recordEvent({ eventType: 'LLM_CALL', commandName: getRunContext().command, provider: event.provider, modelUsed: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens, durationMs: event.durationMs, success: event.ok });
  telemetry.recordAudit({ action: 'llm:call', resource: `${event.provider}/${event.model}`, status: event.ok ? 'SUCCESS' : 'FAILED', details: event.error });
});

function recordCommand(exitCode: number): void {
  const ctx = getRunContext();
  if (!ctx.command || ctx.command === 'mcp') return; // the MCP server records per tool call
  getTelemetry().recordEvent({ eventType: 'COMMAND_EXECUTION', commandName: ctx.command, durationMs: Date.now() - ctx.startedAt, exitCode, success: exitCode === 0 });
}

function renderError(error: GhkError): void {
  const ctx = getRunContext();
  if (ctx.json) {
    emitJson({
      ok: false,
      command: ctx.command,
      version: CLI_VERSION,
      error: { type: error.name, exitCode: error.exitCode, message: error.message, hint: error.hint, details: error.details }
    });
    return;
  }
  logger.error(error.message);
  if (error.hint) logger.warn(`Hint: ${error.hint}`);
  const cause = (error as { cause?: unknown }).cause;
  if (ctx.verbose && cause instanceof Error && cause.stack) console.error(cause.stack);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  setRunContext({ startedAt: Date.now() });
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and --version are successful exits; anything else is a usage error (already printed by commander).
      const ok = err.code === 'commander.helpDisplayed' || err.code === 'commander.help' || err.code === 'commander.version';
      process.exitCode = ok ? ExitCode.OK : ExitCode.USAGE;
      return process.exitCode;
    }
    const error = toGhkError(err);
    renderError(error);
    process.exitCode = error.exitCode;
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : ExitCode.OK;
  const ctx = getRunContext();
  if (ctx.json && !hasEmittedOutput() && ctx.command !== 'mcp' && ctx.command !== 'web') {
    // Commands without a structured result still produce one JSON document on stdout.
    emitJson({ ok: exitCode === ExitCode.OK, command: ctx.command, version: CLI_VERSION, exitCode });
  }
  recordCommand(exitCode);
  return exitCode;
}

process.on('unhandledRejection', (reason) => {
  renderError(toGhkError(reason));
  process.exitCode = ExitCode.GENERIC;
});

if (require.main === module) {
  void main();
}
