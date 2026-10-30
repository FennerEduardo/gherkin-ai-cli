/* ==========================================================================
   gherkin-ai-cli - CLI commands: specification (create, lint, validate, export, lang, industry, speckit)
   ========================================================================== */

import type { Command } from 'commander';

export function registerSpecificationCommands(program: Command): void {
  program
    .command('lang')
    .alias('l')
    .alias('language')
    .description('Configure CLI preferred interaction language (English or Spanish)')
    .option('-s, --set <locale>', 'Set language directly (en or es)')
    .action(async (options) => {
      await (await import('../commands/lang')).handleLangCommand(options);
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
      await (await import('../commands/create')).handleCreateCommand(options);
    });

  program
    .command('validate')
    .alias('v')
    .description('Validate Gherkin specification and architecture rules compliance')
    .option('-f, --feature <file>', 'Path to Gherkin .feature file')
    .option('-c, --config <file>', 'Path to custom gherkin-ai.config.json file')
    .option('--openapi <file>', 'Path to OpenAPI spec file to validate against IR')
    .option('--asyncapi <file>', 'Path to AsyncAPI spec file to validate against IR')
    .option('-t, --target <dir>', 'Directory to validate (defaults to the configured outputDir)')
    .option('--strict-steps', 'With -f: fail when a step of the feature matches no step definition (otherwise a warning)')
    .action(async (options) => {
      await (await import('../commands/validate')).handleValidateCommand(options);
    });

  program
    .command('export')
    .alias('e')
    .description('Export single AI Agent context bundle (Markdown or JSON)')
    .option('-f, --feature <file>', 'Path to Gherkin .feature file')
    .option('--format <type>', 'Export format (json or md)', 'md')
    .option('-o, --output <file>', 'Output destination file path')
    .action(async (options) => {
      await (await import('../commands/export')).handleExportCommand(options);
    });

  program
    .command('lint')
    .description('Lint Gherkin specifications against 16 quality rules plus the rules of the project industry (industry.id)')
    .option('-f, --feature <file>', 'Specific feature file to lint')
    .option('--threshold <score>', 'Minimum passing score 0-100 (default: 70); below it exits with code 4')
    .option('--rules', 'List available lint rules')
    .option('--all', 'Lint every feature of every gherkin-ai project under the current directory')
    .option('--explain-ir', 'Show the aggregate, route, commands and events the generator will use, and where each name comes from')
    .option('--allow-empty', 'Succeed when the project has no feature files (default: exit 2)')
    .option('--json', 'Output report as JSON')
    .action(async (options) => {
      await (await import('../commands/lint')).handleLintCommand(options);
    });

  program
    .command('industry [subcommand] [id]')
    .description('Industry reference standards (BIAN, TM Forum, HL7 FHIR, ...): list | show <id> | apply <id>')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, id, options) => {
      const { handleIndustryCommand } = await import('../commands/industry');
      await handleIndustryCommand(subcommand, id, { ...options, json: options.json || program.opts().json });
    });

  program
    .command('speckit <direction>')
    .description('GitHub Spec Kit interop: `import` specs/NNN-*/spec.md into .feature files, or `export` .feature files as Spec Kit specs')
    .option('--dir <dir>', 'import: Spec Kit specs directory (default: specs or .specify/specs)')
    .option('--out <dir>', 'Output directory (import: features, export: specs)')
    .option('--force', 'Overwrite existing files')
    .option('--json', 'Output as JSON')
    .action(async (direction, options) => {
      const { handleSpeckitCommand } = await import('../commands/speckit');
      await handleSpeckitCommand(direction, options);
    });
}
