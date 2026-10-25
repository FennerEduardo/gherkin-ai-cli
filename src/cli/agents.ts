/* ==========================================================================
   gherkin-ai-cli - CLI commands: agents (implement, context, mcp, skill, autopilot, agent-log, web, doc)
   ========================================================================== */

import type { Command } from 'commander';

export function registerAgentCommands(program: Command): void {
  program
    .command('mcp [subcommand]')
    .description('Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server or auto-install config (`ghk mcp install`)')
    .option('--install', 'Auto-install MCP config into Cursor and Claude Desktop')
    .action(async (subcommand, options) => {
      await (await import('../commands/mcp')).handleMcpCommand(subcommand, options);
    });

  program
    .command('context [subcommand]')
    .description('Build and package project context and conventions into .ghe/')
    .action(async (subcommand) => {
      await (await import('../commands/context')).handleContextCommand(subcommand);
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
    .option('--host', 'Run the repair loop\'s tests on this machine instead of the sandbox container')
    .action(async (options) => {
      // Like verify, autopilot only writes LLM output to disk with an explicit --apply.
      if (!options.apply) process.env.GHK_DRY_RUN = 'true';
      await (await import('../commands/autopilot')).handleAutopilotCommand(options);
    });

  program
    .command('skill')
    .alias('s')
    .description('Configure Gherkin AI as a native tool/skill for AI IDEs like Cursor and Windsurf')
    .action(async () => {
      const { handleSkillCommand } = await import('../commands/skill');
      await (await import('../commands/skill')).handleSkillCommand();
    });

  program
    .command('web')
    .alias('w')
    .alias('ui')
    .description('Launch local Web UI Server to visually guide the generation process')
    .option('-p, --port <number>', 'Port to run the web server on')
    .action(async (options) => {
      await (await import('../commands/web')).handleWebCommand(options);
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
      await (await import('../commands/implement')).handleImplementCommand(options);
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
      await (await import('../commands/agent-log')).handleAgentLogCommand(options);
    });

  program
    .command('doc')
    .alias('site')
    .description('Generate Living Documentation (Static Site) from Gherkin specifications')
    .action(async () => {
      const { handleDocCommand } = await import('../commands/doc');
      await handleDocCommand();
    });
}
