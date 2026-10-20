/* ==========================================================================
   gherkin-ai-cli - CLI commands: verification and governance (converge, diff, impact, risk, report, graph, firewall, verify, quality, evaluate, pr-review, bench)
   ========================================================================== */

import type { Command } from 'commander';

export function registerVerificationCommands(program: Command): void {
  program
    .command('verify')
    .alias('v-loop')
    .description('Run closed-loop verification test harness (dry-run by default) with optional agent auto-fix and docker isolation')
    .option('--auto-fix', 'Invoke agent self-healing loop on test failure')
    .option('--apply', 'Apply agent self-healing code modifications to filesystem (disables dry-run)')
    .option('--docker', "Run the tests in a disposable container with the stack's toolchain image (no network, CPU/memory limits, read-only root)")
    .option('--docker-network <mode>', 'Docker network for --docker: none (default) or bridge when tests must download dependencies')
    .option('--isolated', 'Generate docker-compose on the fly to spin up isolated DB/Brokers (Testcontainers mode)')
    .option('--services', 'Run the runtime integration tests in the toolchain container against PostgreSQL 17 and RabbitMQ 4 (implies --docker)')
    .option('--max-retries <number>', 'Maximum auto-fix retries (default: 3)', '3')
    .option('-c, --command <cmd>', 'Custom test execution command')
    .option('--allow-unattended-writes', 'Allow --apply in CI (otherwise refused; see policy.allowUnattendedWrites)')
    .option('--force-branch', 'Allow --apply on a protected branch (main/master by default)')
    .action(async (options) => {
      // If --apply is not passed, force dry run
      if (!options.apply) {
        process.env.GHK_DRY_RUN = 'true';
      }
      await (await import('../commands/verify')).handleVerifyCommand(options);
    });

  program
    .command('quality')
    .alias('q')
    .description('Calculate feature quality score index and enterprise gate compliance (exit 4 when human approval is required)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await (await import('../commands/quality')).handleQualityCommand({ ...options, json: options.json || program.opts().json });
    });

  program
    .command('diff')
    .description('Run Drift Detection to ensure code DTOs match Gherkin specs')
    .option('-f, --feature <file>', 'Gherkin feature file source of truth')
    .option('-t, --target <file>', 'Target source code file (e.g. DTO or Contract)')
    .action(async (options) => {
      await (await import('../commands/diff')).handleDiffCommand(options);
    });

  program
    .command('evaluate <files...>')
    .alias('eval')
    .description('Evaluate one or more files for code quality and architectural pattern compliance')
    .option('--max-file-lines <number>', 'Maximum lines allowed per file (default: 300)')
    .option('--max-class-lines <number>', 'Maximum lines allowed per class (default: 200)')
    .action(async (files, options) => {
      await (await import('../commands/evaluate')).handleEvaluateCommand(files, options);
    });

  program
    .command('report')
    .description('Publish lint, convergence and risk on the pull / merge request: GitHub annotations + step summary, or a GitLab Code Quality report')
    .option('--provider <name>', 'github | gitlab (default: gitlab inside GitLab CI, else github)')
    .option('--base <ref>', 'Git ref the delivery risk is assessed against (e.g. origin/main)')
    .option('--threshold <score>', 'Minimum lint score (default: 70); below it exits with code 4')
    .option('--fail-on <level>', 'Exit with code 4 when the delivery risk reaches this level')
    .option('--out <file>', 'gitlab: Code Quality report path (default: gl-code-quality-report.json)')
    .option('--json', 'Output a summary as JSON')
    .action(async (options) => {
      await (await import('../commands/report')).handleReportCommand({ ...options, json: options.json || program.opts().json });
    });

  program
    .command('converge')
    .alias('conv')
    .description('Measure Specification-to-Implementation alignment across 6 architectural dimensions')
    .option('-f, --feature <file>', 'Specific feature file to evaluate')
    .option('--threshold <score>', 'Minimum convergence 0-100 (default: 80); below it exits with code 7')
    .option('--strict', 'Deprecated: the threshold is always enforced')
    .option('--all', 'Evaluate every feature of every gherkin-ai project under the current directory')
    .option('--json', 'Output report as JSON')
    .action(async (options) => {
      await (await import('../commands/converge')).handleConvergeCommand(options);
    });

  program
    .command('impact')
    .description('Analyze blast radius of specification changes')
    .option('-f, --feature <file>', 'Feature file to analyze')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { handleImpactCommand } = await import('../commands/impact');
      await handleImpactCommand(options);
    });

  program
    .command('graph')
    .description('Semantic repository graph: links features, scenarios, commands, events and endpoints to the files and tests that implement them')
    .option('--format <format>', 'summary (default) | json | mermaid | dot')
    .option('-o, --output <file>', 'Write the graph to a file (default format: json)')
    .option('--trace <symbol>', 'Traceability for one command, event, endpoint, scenario, feature or file')
    .option('--depth <hops>', 'Hops to follow for --trace (default: 3)')
    .option('--scope <feature>', 'Files and directories a change to this feature may touch (used by the agent firewall)')
    .option('--serve', 'Serve the live graph in the browser (127.0.0.1, token-protected) until Ctrl+C')
    .option('--port <port>', 'With --serve: port (default: 4300; 0 picks a free one)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { handleGraphCommand } = await import('../commands/graph');
      await handleGraphCommand(options);
    });

  program
    .command('bench <subcommand> [dir]')
    .description('A/B benchmark: run your coding agent on the same task with and without gherkin-ai and score both deterministically (init | run)')
    .option('--agent <command>', 'Agent command ({prompt_file}, {workspace}, {arm} are substituted); overrides bench.json')
    .option('--repetitions <n>', 'Runs per arm (default: bench.json or 1)')
    .option('--arms <list>', 'Comma-separated arms to run (default: control,ghk)')
    .option('--out <dir>', 'Report directory (default: <dir>/results/<timestamp>)')
    .option('--dry-run', 'Prepare the workspaces without running the agent')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, dir, options) => {
      const { handleBenchCommand } = await import('../commands/bench');
      await handleBenchCommand(subcommand, dir, { ...options, dryRun: options.dryRun || program.opts().dryRun });
    });

  program
    .command('risk')
    .description('Delivery risk of a change (LOW / MEDIUM / HIGH / CRITICAL): security, business criticality, change radius, tests, contract and architecture drift')
    .option('--base <ref>', 'Assess the diff against this git ref (e.g. origin/main); default: the working tree')
    .option('--files <list>', 'Comma-separated change set instead of git')
    .option('--fail-on <level>', 'Exit with code 4 when the risk is at least this level (for CI)')
    .option('--calibrate', 'Propose policy.risk.weights from the git history (commits later touched by a fix count as risky)')
    .option('--commits <n>', 'With --calibrate: commits of history to use (default: 300)')
    .option('--write', 'With --calibrate: save the weights to gherkin-ai.config.json')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { handleRiskCommand } = await import('../commands/risk');
      await handleRiskCommand(options);
    });

  program
    .command('firewall [subcommand]')
    .description('Agent firewall: check whether an agent may write a path, run a command, reach a host, read a secret or call a tool (check | policy | hook)')
    .option('--write <path>', 'check: a file the agent wants to write')
    .option('--exec <command>', 'check: a command line the agent wants to run')
    .option('--network <host>', 'check: a host or URL the agent wants to reach')
    .option('--secret <name>', 'check: a secret or environment variable the agent wants to read')
    .option('--tool <name>', 'check: an MCP tool the agent wants to call')
    .option('-f, --feature <file>', 'Limit writes to the impact scope of this feature')
    .option('--agent <name>', 'Agent name recorded in the audit trail')
    .option('--json', 'Output as JSON')
    .action(async (subcommand, options) => {
      const { handleFirewallCommand } = await import('../commands/firewall');
      await handleFirewallCommand(subcommand, options);
    });

  program
    .command('pr-review')
    .description('AI Code Reviewer for Pull Requests checking architectural drift')
    .option('-f, --feature <file>', 'Feature file to validate the PR against')
    .option('--diff <file>', 'Path to git patch/diff file (defaults to stdin)')
    .action(async (options) => {
      const { handlePrReviewCommand } = await import('../commands/pr-review');
      await handlePrReviewCommand(options);
    });
}
