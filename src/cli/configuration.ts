/* ==========================================================================
   gherkin-ai-cli - CLI commands: configuration, credentials and audit (config, login, logout, auth, audit, sbom)
   ========================================================================== */

import type { Command } from 'commander';
import { UsageError } from '../core/errors';

export function registerConfigurationCommands(program: Command): void {
  program
    .command('config [subcommand]')
    .description('Inspect the resolved configuration: show (default) | validate | schema')
    .option('-c, --config <file>', 'Path to project gherkin-ai.config.json')
    .option('--sources', 'Show which layer (organization, user, project, environment) provided each value')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, options) => {
      const { handleConfigCommand } = await import('../commands/config');
      await handleConfigCommand(subcommand, { ...options, json: options.json || program.opts().json });
    });

  program
    .command('login')
    .description('Select the LLM provider and store its API key in the OS keychain (never on disk)')
    .option('--provider <name>', 'openai | openai-compatible | azure-openai | anthropic | bedrock | gemini | vertex | ollama | ide_delegate')
    .option('--api-key-stdin', 'Read the API key from standard input (non-interactive)')
    .action(async (options) => {
      await (await import('../commands/login')).handleLoginCommand(options);
    });

  program
    .command('logout')
    .description('Remove API keys stored in the OS keychain')
    .option('--provider <name>', 'Only remove the key for this provider')
    .action(async (options) => {
      const { handleLogoutCommand } = await import('../commands/login');
      await handleLogoutCommand(options);
    });

  program
    .command('auth [subcommand]')
    .description('Show the effective LLM provider, model, credential source and network settings (`ghk auth status`)')
    .option('--json', 'Output as JSON')
    .action(async (subcommand) => {
      if (subcommand && subcommand !== 'status') throw new UsageError(`Unknown auth subcommand "${subcommand}".`, { hint: 'Use `ghk auth status`.' });
      const { handleAuthStatusCommand } = await import('../commands/login');
      await handleAuthStatusCommand();
    });

  program
    .command('sbom')
    .description('Generate Software Bill of Materials (CycloneDX)')
    .action(async () => {
      const { handleSbomCommand } = await import('../commands/sbom');
      await handleSbomCommand();
    });

  program
    .command('audit [subcommand]')
    .alias('inventory')
    .alias('inv')
    .alias('history')
    .description('View the feature inventory, or `ghk audit export` the security audit trail (JSONL, CSV or OCSF) for a SIEM')
    .option('-f, --feature <file>', 'Filter audit trail by feature spec or name')
    .option('--json', 'Output audit records as JSON for CI/CD pipelines')
    .option('--html', 'Generate an HTML compliance report')
    .option('--clear', 'Clear/purge the feature inventory (the action itself is audited)')
    .option('--format <format>', 'export: jsonl (default), csv or ocsf (OCSF 1.3 API Activity events)')
    .option('--since <when>', 'export: ISO date or window such as 24h, 7d')
    .option('-o, --output <file>', 'export: write to a file instead of stdout')
    .action(async (subcommand, options) => {
      if (subcommand === 'export') {
        const { handleAuditExportCommand } = await import('../commands/audit-export');
        await handleAuditExportCommand(options);
        return;
      }
      if (subcommand) throw new UsageError(`Unknown audit subcommand "${subcommand}".`, { hint: 'Use `ghk audit` or `ghk audit export`.' });
      await (await import('../commands/audit')).handleAuditCommand(options);
    });
}
