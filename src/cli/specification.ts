/* ==========================================================================
   gherkin-ai-cli - CLI commands: specification (create, lint, validate, export, lang, industry, speckit, reverse)
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
    .option('--assist', 'Ask the configured LLM to propose @aggregate/@command/@event tags where the extraction finds no names (GHK016); writes patch proposals only')
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
    .description('GitHub Spec Kit interop: `import` specs/NNN-*/spec.md into .feature files, `export` .feature files as Spec Kit specs, or `verify` that every story, requirement and completed task has a scenario and the code converges (exit 7 on drift)')
    .option('--dir <dir>', 'import, verify: Spec Kit specs directory (default: specs or .specify/specs)')
    .option('--out <dir>', 'Output directory (import: features, export: specs; verify: where the .feature files are)')
    .option('--force', 'Overwrite existing files')
    .option('--threshold <score>', 'verify: minimum convergence 0-100 (default: 80)')
    .option('--json', 'Output as JSON')
    .action(async (direction, options) => {
      const { handleSpeckitCommand } = await import('../commands/speckit');
      await handleSpeckitCommand(direction, options);
    });

  const collect = (value: string, previous: string[] = []) => [...previous, value];
  program
    .command('plugin [subcommand] [args...]')
    .description('Plugins (API 2): `list` the project\'s plugins and what they add; `new <analyzer|lint-rule|gateway> <name>` creates a working plugin; `verify <dir>` runs the conformance kit (exit 4 on a failed check); `lock` pins their bytes in .ghk/plugins.lock')
    .option('--dir <dir>', 'new: where to create the plugin (default: a directory named after it)')
    .option('--force', 'new: write into a directory that is not empty')
    .option('--run-tools', 'verify: also run each gateway provider\'s validation tool (terraform, bicep) on its files')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, args, options) => {
      const { handlePluginCommand } = await import('../commands/plugin');
      await handlePluginCommand(subcommand, args ?? [], { ...options, json: options.json || program.opts().json });
    });
  program
    .command('expose [subcommand] [args...]')
    .description('Expose the service\'s business capabilities to agents as MCP tools: `discover` proposes the capability manifest from the features, the OpenAPI contract and the industry profile (never approves; writes only .ghe/expose/); `review [id…]` shows each capability; `approve <id…> | --all --env <e>` writes the approved ones to .ghk/capabilities.yaml (exit 5 when a policy refuses); `revoke <id…>`; `validate` checks the approved manifest (exit 5: a write without approval; exit 4: tool poisoning, contract mismatch, incompatible change); `generate --target mcp-runtime` writes the MCP server of the approved capabilities (stateless Streamable HTTP on :8000/mcp), `--target <provider>` also the gateway files; `plan --target <provider>` shows where each control is enforced; `publish --target <provider> --yes` applies them; `drift` compares the served tools with the manifest (exit 7); `test --agent bedrock --url <endpoint>` runs a reference agent on Amazon Bedrock over the scenarios')
    .option('--contract <file>', 'discover, validate: the service\'s OpenAPI document (default: <outputDir>/openapi.json, openapi.json, contracts/openapi.json)')
    .option('--from-reverse', 'discover: also list the endpoints ghk reverse found that no feature specifies (pending-specification)')
    .option('--all', 'approve: every capability of the proposal that is not pending')
    .option('--env <environment>', 'approve: an environment the capabilities may run in (repeatable; required for writes; production needs allowWrites in the manifest)', collect)
    .option('--by <name>', 'approve: who approves (default: git user.name)')
    .option('--note <text>', 'approve: a note kept with the approval')
    .option('--yes', 'approve, revoke: write without asking')
    .option('--manifest <file>', 'validate: the manifest to check (default: .ghk/capabilities.yaml)')
    .option('--against <file>', 'validate: the previous manifest, for incompatible changes (default: git HEAD)')
    .option('--target <target>', 'generate: mcp-runtime (default) or a gateway provider (container, aws-agentcore, or one of a plugin), which also writes the runtime; plan, publish: the provider')
    .option('--out <dir>', 'generate, publish, drift: the directory of the generated targets (default: expose; each target goes in a sub-directory)')
    .option('--image <uri>', 'generate, plan: container image of the MCP runtime the gateway hosts')
    .option('--discovery-url <url>', 'generate, plan: OIDC discovery URL of the callers\' identity provider (the gateway\'s JWT authorizer)')
    .option('--audience <id>', 'generate, plan: an accepted audience or client id (repeatable)', collect)
    .option('--region <region>', 'generate, plan: cloud region')
    .option('--url <url>', 'drift: a deployed MCP endpoint (default: the generated runtime in expose/mcp-runtime)')
    .option('--token-env <var>', 'drift, test: environment variable that holds the bearer token for --url (drift: a token with every scope)')
    .option('--agent <agent>', 'test: the reference agent (bedrock: a model on Amazon Bedrock picks and calls a tool for each scenario; skipped without AWS credentials)')
    .option('--model <id>', 'test: the Bedrock model (default: llm.model when llm.provider is bedrock, else the default Bedrock model)')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, args, options) => {
      const { handleExposeCommand } = await import('../commands/expose');
      const global = program.opts();
      await handleExposeCommand(subcommand, args ?? [], { ...options, json: options.json || global.json, dryRun: global.dryRun, yes: options.yes || global.yes });
    });
  program
    .command('reverse [subcommand] [names...]')
    .description('(beta) Reverse engineering: `scan` reads controllers, services, repositories, models, tests and OpenAPI documents into evidence; `propose` turns it into candidate .feature files with source traceability; `accept <aggregate…>` moves reviewed proposals into the specifications; `coverage` reports the share of the code the features specify; `explain <operation>` shows where its names, confidence and evidence come from; `review [aggregate…]` shows each scenario with the code behind it and records approve/reject decisions that `accept` follows; `sync` compares the accepted features with the code and exits 7 on drift, with a patch to review. Deterministic, works without ghk init')
    .option('--path <dir>', 'scan: sub-directory to analyse (default: the whole project)')
    .option('--include <glob>', 'scan: only files matching this glob (repeatable)', collect)
    .option('--exclude <glob>', 'scan: skip files matching this glob (repeatable)', collect)
    .option('--openapi <file>', 'scan: read this OpenAPI document as evidence (repeatable; default: openapi/swagger files found in the repository)', collect)
    .option('--no-tests', 'scan: do not read tests as evidence')
    .option('--coverage-report <file>', 'scan: an lcov, JaCoCo or Cobertura report from a test run; evidence whose line ran and whose endpoint a test calls becomes confirmed (repeatable)', collect)
    .option('--scope <name>', 'propose: only this aggregate or operation (repeatable)', collect)
    .option('--min-confidence <level>', 'propose: leave out scenarios below confirmed | strong | inferred (default: inferred)')
    .option('--threshold <score>', 'propose: minimum lint score of a proposal 0-100 (default: 80); below it exits with code 4')
    .option('--rescan', 'propose, coverage: scan again instead of reading .ghe/reverse/scan.json')
    .option('--assist', 'propose: ask the configured LLM for a title, user story and clearer scenario names (never steps); validated and written as patch proposals in .ghe/patches/')
    .option('--all', 'accept: every proposal')
    .option('--to <dir>', 'accept: destination directory (default: features/discovered)')
    .option('--merge', 'accept: leave out operations a feature already specifies (same or renamed command); exit 7 when a feature declares commands the code does not implement')
    .option('--force', 'accept: overwrite existing feature files')
    .option('--approve <selector>', 'review: approve a scenario (its name), every scenario of an operation (@Command) or all (repeatable)', collect)
    .option('--reject <selector>', 'review: reject a scenario, @Command or all (repeatable)', collect)
    .option('--note <text>', 'review: note stored with the decisions')
    .option('--interactive', 'review: step through the pending scenarios in the terminal')
    .option('--context <lines>', 'review: lines of code shown around each evidence location (default: 3)')
    .option('--all-features', 'sync: also report commands any feature declares and the code does not implement')
    .option('--ignore-review', 'accept: take every scenario even when a review is on file')
    .option('--format <format>', 'coverage: text (default) | markdown (a pull-request comment) | html (one static page)')
    .option('--output <file>', 'coverage --format: write the report to this file instead of stdout')
    .option('--min <pct>', 'coverage: minimum share of operations specified by features; below it exits with code 7')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, names, options) => {
      const { handleReverseCommand } = await import('../commands/reverse');
      const global = program.opts();
      await handleReverseCommand(subcommand, { ...options, json: options.json || global.json, dryRun: global.dryRun, yes: options.yes || global.yes }, names ?? []);
    });
}
