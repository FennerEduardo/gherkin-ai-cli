/* ==========================================================================
   gherkin-ai-cli - Main Commander CLI Entry Point
   ========================================================================== */

import { Command, CommanderError } from 'commander';
import { ExitCode, GhkError, toGhkError } from './core/errors';
import { getRunContext, isNonInteractive, setRunContext } from './core/run-context';
import { logger } from './utils/logger';
import { configureTelemetry, defaultTelemetryDir, getTelemetry, EXECUTION_ID } from './core/telemetry';
import { onLLMUsage } from './core/llm';
import { emitJson, enterJsonMode, hasEmittedOutput } from './utils/output';

// Version from package.json (single source of truth)
import { CLI_VERSION } from './version';
import { registerSpecificationCommands } from './cli/specification';
import { registerGenerationCommands } from './cli/generation';
import { registerVerificationCommands } from './cli/verification';
import { registerAgentCommands } from './cli/agents';
import { registerConfigurationCommands } from './cli/configuration';

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

// Commands, in the groups of docs/COMMANDS.md (src/cli/).
registerSpecificationCommands(program);
registerGenerationCommands(program);
registerVerificationCommands(program);
registerAgentCommands(program);
registerConfigurationCommands(program);

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
const WORKSPACE_FREE_COMMANDS = new Set(['config', 'stacks', 'login', 'logout', 'auth', 'lang', 'mcp', 'web', 'firewall']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const globals = program.opts();
  const commandName = actionCommand === program ? 'root' : actionCommand.name();
  const local = actionCommand === program ? {} : actionCommand.opts();
  const json = Boolean(globals.json || local.json);

  setRunContext({
    command: commandName,
    // Without a terminal (CI, a pipe, stdin closed) a prompt cannot be answered: take the defaults.
    nonInteractive: Boolean(globals.yes || globals.nonInteractive || json || !process.stdin.isTTY),
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

  // --all (lint, converge, upgrade --kernel) covers every project under the current directory itself.
  if (!WORKSPACE_FREE_COMMANDS.has(commandName) && !local.all) {
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
    configureTelemetry(process.cwd(), { dir: config.telemetry?.dir ?? defaultTelemetryDir(process.cwd()), telemetryEnabled: config.telemetry?.enabled, auditEnabled: config.audit?.enabled });
  } catch (err) {
    // `config` and `upgrade` report invalid configuration themselves.
    if (err instanceof GhkError && err.exitCode === ExitCode.CONFIG && commandName !== 'config' && commandName !== 'upgrade') throw err;
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
