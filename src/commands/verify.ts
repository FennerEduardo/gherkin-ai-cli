/* ==========================================================================
   gherkin-ai-cli - 'verify' Command Handler (Closed-Loop Verification Engine)
   ========================================================================== */

import { assertAgentWritesAllowed, reportAgentWrite, writeAgentFile } from '../core/governance/write-guard';
import { AgentFirewall } from '../core/governance/agent-firewall';
import { ExitCode, GhkError } from '../core/errors';
import { brokerServices, RunningServices, startServices } from '../core/services';
import { runtimeBroker } from '../generators/deploy/broker-env';
import { toKebab } from '../utils/naming';
import chalk from 'chalk';
import crypto from 'crypto';
import path, { resolve as resolvePath } from 'path';
import { existsSync, readFileSync } from 'fs';
import { validateGuardrails } from '../core/guardrails';
import { validateTypeScriptSyntax } from '../core/syntax-validator';
import { resolveSafePath } from '../utils/file-system';
import { calculateConvergence } from '../core/convergence-engine';
import { parseGherkinText } from '../core/gherkin-parser';
import { buildIR } from '../core/ir-builder';
import { AgentChangeSet, writeProposal } from '../core/governance/agent-changes';
import { projectFeatureFiles } from '../core/workspace-projects';
import { DEFAULT_CONTAINER_LIMITS, executeSandbox, SandboxExecutionOptions } from '../core/execution-sandbox';
import { resolveToolchain } from '../generators/toolchains';
import { parseExecutionFailure } from '../core/error-parser';
import { planDeterministicRepair } from '../core/deterministic-repair';
import { RealAgentProvider, LLMConfig, resolveLLMConfig } from '../core/agent-adapter';
import { loadConfig } from '../core/config';
import { MetricsEngine } from '../core/metrics-engine';

export interface VerifyCommandOptions {
  autoFix?: boolean;
  docker?: boolean;
  /** Docker network for --docker (default "none"). */
  dockerNetwork?: string;
  isolated?: boolean;
  /** Run the runtime integration suite against PostgreSQL and RabbitMQ (implies --docker). */
  services?: boolean;
  /** Fail (exit 7) when the convergence score is below this, after the tests pass. Unset: reported only. */
  convergeThreshold?: string;
  maxRetries?: string | number;
  /** Feature the repair is for: the agent may only write inside its impact scope (`ghk graph --scope`). */
  feature?: string;
  command?: string;
  allowUnattendedWrites?: boolean;
  forceBranch?: boolean;
  /** With --auto-fix: run on this machine instead of the sandbox (credentials are left out of the environment). */
  host?: boolean;
}

/** Average convergence of the project's features, as `ghk converge` computes it; undefined without features. */
function convergenceScore(cwd: string): number | undefined {
  let files: string[];
  try { files = projectFeatureFiles(cwd); } catch { return undefined; }
  const scores = files.flatMap(file => {
    try { return [calculateConvergence(parseGherkinText(readFileSync(file, 'utf8')), file, cwd).overallConvergence]; } catch { return []; }
  });
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined;
}

/**
 * Requirements specified in the project's features and how many of them a test references (the
 * Traceability dimension of `ghk converge`). Undefined without features: the metric is then unavailable.
 */
export function specRequirementCoverage(cwd: string): { covered: number; total: number } | undefined {
  let files: string[];
  try { files = projectFeatureFiles(cwd); } catch { return undefined; }
  let covered = 0;
  let total = 0;
  for (const file of files) {
    try {
      const coverage = buildIR(parseGherkinText(readFileSync(file, 'utf8')), file).traceability.coverage;
      covered += coverage.testedRequirements;
      total += coverage.specifiedRequirements;
    } catch { /* an unparsable feature is reported by lint, not here */ }
  }
  return total ? { covered, total } : undefined;
}

export async function handleVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔁 Executing Closed-Loop Verification Pipeline...\n'));

  const maxRetries = parseInt(String(options.maxRetries || '3'), 10);
  const config = loadConfig();
  // Arguments first (usage error, exit 2), then the write policy (CI and protected-branch guards, exit 5).
  if (options.feature && !existsSync(resolvePath(process.cwd(), options.feature))) {
    throw new GhkError(`Feature file not found: ${options.feature}`, ExitCode.USAGE);
  }
  if (options.autoFix && process.env.GHK_DRY_RUN !== 'true') {
    assertAgentWritesAllowed(config, { command: 'verify', allowUnattendedWrites: options.allowUnattendedWrites, forceBranch: options.forceBranch });
  }
  // With --feature, the repair loop may only write inside that feature's impact scope.
  const firewall = AgentFirewall.forWorkspace(process.cwd(), config, options.feature ? { feature: options.feature } : {});
  // --isolated used to write its own docker-compose.test.yml with older images; it is now --services.
  if (options.isolated) {
    console.log(chalk.yellow('   --isolated is deprecated: it runs as --services (the same containers as the golden builds).'));
    options.services = true;
  }
  // --services runs the runtime integration suite in the toolchain container against real PostgreSQL and the broker.
  if (options.services) options.docker = true;
  // --auto-fix runs code an LLM wrote: in the disposable container unless --host says otherwise.
  if (options.autoFix && !options.docker) {
    if (options.host) {
      console.log(chalk.yellow('   --host: the agent\'s code runs on this machine, with your files and network. LLM, cloud and registry credentials are left out of its environment.'));
    } else {
      options.docker = true;
      console.log(chalk.gray('   --auto-fix runs the tests in the sandbox container (pass --host to run them on this machine).'));
    }
  }
  // In a container, default to the stack's verified toolchain image and test commands.
  const toolchain = options.docker ? resolveToolchain(config) : undefined;
  if (options.services && !toolchain?.integration?.length) {
    throw new GhkError(`The ${config.stack.language}/${config.stack.framework} stack has no runtime integration suite.`, ExitCode.USAGE, {
      hint: 'verify --services runs the integration tests of the generated runtime kernel (backends only).'
    });
  }
  // The toolchain's commands build and test the generated project, which lives in outputDir; a command of
  // your own (-c, testCommand) runs where you call verify.
  const fromToolchain = Boolean(toolchain) && (options.services || (!options.command && !config.testCommand));
  const sandboxOpts: SandboxExecutionOptions = {
    cwd: fromToolchain ? resolvePath(process.cwd(), config.outputDir || './') : process.cwd(),
    command: options.command,
    configCommand: options.services
      ? [...(toolchain?.build ?? []), ...(toolchain?.integration ?? [])].join(' && ')
      : config.testCommand ?? (toolchain ? toolchain.test.join(' && ') : undefined),
    docker: options.docker || false,
    dockerImage: config.sandbox?.image ?? toolchain?.image,
    limits: {
      network: options.dockerNetwork ?? config.sandbox?.network,
      memory: config.sandbox?.memory,
      cpus: config.sandbox?.cpus,
      pidsLimit: config.sandbox?.pidsLimit
    },
    env: toolchain?.env,
    caches: toolchain?.caches,
    // The integration suite installs the stack's dependencies like the golden builds do (pip, Bundler and
    // PHP extensions write into system directories), so it runs in the image's own disposable root.
    profile: options.services ? 'toolchain' : 'strict',
    scrubCredentials: Boolean(options.autoFix)
  };
  let services: RunningServices | undefined;
  if (options.services) {
    // The broker the runtime kernel uses (stack.messaging), with the same containers as the golden builds.
    const extra = [...brokerServices(runtimeBroker(config), toKebab(config.projectName)), ...(config.sandbox?.services ?? [])];
    console.log(chalk.cyan(`   Starting PostgreSQL and RabbitMQ${extra.length ? ` (+ ${extra.map(s => s.name).join(', ')})` : ''}...`));
    services = startServices(config.projectName, extra);
    sandboxOpts.env = { ...(sandboxOpts.env ?? {}), ...services.env };
    // The services network also gives the build access to package registries.
    sandboxOpts.limits = { ...sandboxOpts.limits, network: services.network };
    sandboxOpts.timeoutMs = 30 * 60 * 1000;
  }
  if (options.docker) {
    const limits = { ...DEFAULT_CONTAINER_LIMITS, ...Object.fromEntries(Object.entries(sandboxOpts.limits ?? {}).filter(([, v]) => v !== undefined)) };
    console.log(chalk.gray(`   Container: ${sandboxOpts.dockerImage} (network=${limits.network}, memory=${limits.memory}, cpus=${limits.cpus}, ${sandboxOpts.profile === 'strict' ? 'read-only root' : 'toolchain root, disposable'})\n`));
  }

  let iteration = 1;
  let success = false;
  let drift = false;
  let testsPassed = false;
  // Every file the repair loop writes; undone in `finally` unless the tests ended up passing.
  const changes = new AgentChangeSet();
  let guardrailViolationPrompt: string | null = null;
  const metricsEngine = new MetricsEngine();
  const execEvents: any[] = [];
  const execErrors: any[] = [];
  const previousPatchHashes = new Set<string>();

  try {
    const triedRepairs = new Set<string>();
    while (iteration <= maxRetries && !success) {
      console.log(chalk.bold.blue(`[Iteration ${iteration}/${maxRetries}] Running Test Harness...`));
      
      const result = executeSandbox(sandboxOpts);

    if (result.success) {
      console.log(chalk.bold.green(`\n✅ Suite Verification Passed! (Duration: ${result.durationMs}ms)`));
      console.log(chalk.green(`   Executed command: ${result.commandExecuted}\n`));
      metricsEngine.recordTestRun(true);
      execEvents.push({ type: 'test_passed', iteration, durationMs: result.durationMs });
      success = true;
      testsPassed = true;

      // Convergence is reported; it gates only when asked (the same gate as `ghk converge --threshold`).
      const score = convergenceScore(process.cwd());
      const threshold = options.convergeThreshold !== undefined ? Number(options.convergeThreshold) : undefined;
      if (score === undefined) {
        console.log(chalk.gray('   Convergence: no feature files found.'));
      } else if (threshold === undefined) {
        console.log(chalk.gray(`   Convergence: ${score}% (reported only; gate it with --converge-threshold <score> or ghk converge --threshold).`));
      } else if (score < threshold) {
        console.log(chalk.bold.red(`\n✖ Tests passed, but convergence is ${score}%, below --converge-threshold ${threshold}% (run ghk converge for the breakdown).`));
        success = false;
        drift = true;
      } else {
        console.log(chalk.green(`   Convergence: ${score}% (threshold ${threshold}%).`));
      }
      break;
    }

    console.log(chalk.bold.yellow(`\n❌ Execution Failed (Exit Code: ${result.exitCode})`));
    const diagnosis = parseExecutionFailure(result);

    console.log(chalk.yellow(`   Diagnosis: ${diagnosis.summary}`));
    // The end of the output is usually the cause (a missing module, a failed assertion, a read-only path).
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-25).join('\n');
    if (tail) console.log(chalk.gray(`   --- last lines of the output ---\n${tail.replace(/^/gm, '   ')}`));
    if (guardrailViolationPrompt) {
      diagnosis.suggestedFixContext = guardrailViolationPrompt;
      guardrailViolationPrompt = null;
      console.log(chalk.yellow(`   [Injected Guardrail Violation to Agent Context]`));
    }

    if (diagnosis.affectedFiles.length > 0) {
      console.log(chalk.gray(`   Affected files: ${diagnosis.affectedFiles.join(', ')}`));
    }

    if (!options.autoFix) {
      console.log(chalk.gray('\n   Tip: Re-run with --auto-fix to invoke agent self-healing repair loops.\n'));
      metricsEngine.recordHumanIntervention();
      metricsEngine.recordTestRun(false);
      const logPath = metricsEngine.saveExecutionLog(execEvents, execErrors);
      console.log(chalk.gray(`\n   📊 Execution metrics saved to: ${logPath}`));
      process.exitCode = result.exitCode;
      return;
    }

    if (iteration === maxRetries) {
      console.log(chalk.bold.red(`\n✖ Auto-fix retry limit reached (${maxRetries} attempts).\n`));
      metricsEngine.recordHumanIntervention();
      metricsEngine.recordTestRun(false);
      const logPath = metricsEngine.saveExecutionLog(execEvents, execErrors);
      console.log(chalk.gray(`\n   📊 Execution metrics saved to: ${logPath}`));
      process.exitCode = result.exitCode;
      return;
    }

    // Deterministic repair first (4.5): mechanical failures are fixed (or explained) without a model call.
    const repair = planDeterministicRepair(`${result.stdout}\n${result.stderr}`, { projectDir: process.cwd(), config }, triedRepairs);
    if (repair) {
      triedRepairs.add(repair.ruleId);
      execEvents.push({ type: 'deterministic_repair', iteration, rule: repair.ruleId });
      console.log(chalk.cyan(`\n🔧 Deterministic repair (${repair.ruleId}): ${repair.explanation}`));
      if (repair.stop) {
        metricsEngine.recordHumanIntervention();
        metricsEngine.recordTestRun(false);
        metricsEngine.saveExecutionLog(execEvents, execErrors);
        process.exitCode = result.exitCode;
        return;
      }
      const decision = firewall.evaluate({ kind: 'execute', target: repair.command!, agent: 'verify' });
      if (decision.verdict === 'ALLOW') {
        // Restoring dependencies needs the package registries: network on, the rest of the sandbox unchanged.
        const fixed = executeSandbox({ ...sandboxOpts, command: repair.command, limits: { ...sandboxOpts.limits, network: sandboxOpts.limits?.network === 'none' || !sandboxOpts.limits?.network ? 'bridge' : sandboxOpts.limits.network } });
        console.log(fixed.success ? chalk.green(`   ✔ ${repair.command}`) : chalk.yellow(`   ✖ ${repair.command} failed (exit ${fixed.exitCode}); falling back to the agent.`));
        if (fixed.success) {
          iteration++;
          continue;
        }
      } else {
        console.log(chalk.yellow(`   Not run: ${decision.verdict} by the agent firewall (${decision.rule}). Run it yourself: ${repair.command}`));
      }
    }

    console.log(chalk.cyan(`\n🤖 Invoking Agent Repair Loop (Attempt ${iteration})...`));
    const llmConfig: LLMConfig = resolveLLMConfig();
    const agent = new RealAgentProvider(llmConfig);
    const repairResult = await agent.executeTask({
      id: `fix-${iteration}`,
      type: 'auto_fix',
      prompt: diagnosis.suggestedFixContext,
      contextFiles: diagnosis.affectedFiles,
      diagnosis
    });

    metricsEngine.recordTestRun(false);
    metricsEngine.recordAgentAttempt(repairResult.tokensUsed || 0, repairResult.codeModifications?.length || 0);
    execEvents.push({ type: 'agent_repair_attempt', iteration, tokens: repairResult.tokensUsed });

    console.log(chalk.gray(`   ${repairResult.agentResponse.split('\n')[0]}`));
    
    // Apply Code Modifications if provided by RealAgentProvider
    if (repairResult.codeModifications && repairResult.codeModifications.length > 0) {
      const patchHash = crypto.createHash('sha256').update(JSON.stringify(repairResult.codeModifications)).digest('hex');

      if (previousPatchHashes.has(patchHash)) {
        console.log(chalk.bold.red(`\n⚡ CIRCUIT BREAKER TRIPPED: Agent proposed the exact same code modifications as a previous iteration. Aborting to prevent infinite loop.`));
        success = false;
        break;
      }
      previousPatchHashes.add(patchHash);

      const proposedFiles = repairResult.codeModifications.map((m: any) => m.filePath);
      
      // Anti-Stub Validation (Prevent Agent from leaving TODOs)
      const stubFiles = repairResult.codeModifications.filter((m: any) => 
        /\/\/\s*TODO:|\/\/\s*FIXME:|throw new NotImplementedException/i.test(m.content)
      );

      if (stubFiles.length > 0) {
        console.log(chalk.red(`   ✖ ANTI-STUB VIOLATION: Agent generated placeholder code.`));
        const stubFileNames = stubFiles.map((m: any) => m.filePath).join(', ');
        guardrailViolationPrompt = `CRITICAL ERROR: Your proposed modifications in [${stubFileNames}] contain placeholder stubs (TODO, FIXME, or NotImplementedException).\nThis is strictly forbidden. You MUST write the actual implementation.`;
        iteration++;
        continue;
      }
      
      // Immutable Spec Mode
      const specViolations = proposedFiles.filter((f: string) => f.endsWith('.feature'));
      if (specViolations.length > 0) {
        console.log(chalk.red(`   ✖ GUARDRAIL VIOLATION: Immutable Spec Mode is active. Agent cannot modify .feature files during auto-fix.`));
        guardrailViolationPrompt = `CRITICAL ERROR: You attempted to modify the following specification files: ${specViolations.join(', ')}.\nThis is strictly forbidden. You must fix the implementation code to satisfy the existing specification, NOT change the specification.`;
        iteration++;
        continue;
      }
      
      // A repair changes the implementation: specifications, contracts and tests are what it is measured against.
      const guardrailValidation = validateGuardrails({
        action: 'generate_code',
        targetFiles: proposedFiles,
        mode: 'repair'
      }, process.cwd());
      
      if (!guardrailValidation.allowed) {
        console.log(chalk.red(`   ✖ GUARDRAIL VIOLATION: Agent changes rejected.`));
        for (const v of guardrailValidation.violations) {
          console.log(chalk.red(`     - ${v}`));
        }
        guardrailViolationPrompt = `CRITICAL ERROR: Your proposed modifications violated security guardrails:\n${guardrailValidation.violations.join('\n')}\nRewrite your modifications to comply with these policies.`;
        iteration++;
        continue;
      }

      console.log(chalk.green(`   Applying ${repairResult.codeModifications.length} code modification(s)...`));
      for (const mod of repairResult.codeModifications) {
        try {
          
          if (!validateTypeScriptSyntax(mod.filePath, mod.content)) {
            console.log(chalk.yellow(`     ✖ Skipped writing ${mod.filePath} due to syntax errors.`));
            continue;
          }

          if (process.env.GHK_DRY_RUN === 'true') {
            if (process.env.GHK_STDOUT === 'true') {
              console.log(chalk.yellow(`     [DRY RUN] Proposed changes for ${mod.filePath}:\n${mod.content}`));
            } else {
              const patchPath = writeProposal(process.cwd(), resolveSafePath(process.cwd(), mod.filePath), mod.content);
              console.log(chalk.yellow(`     [DRY RUN] Saved proposed patch to ${path.relative(process.cwd(), patchPath)} (git apply it to take it)`));
            }
            continue;
          }

          const fullPath = resolveSafePath(process.cwd(), mod.filePath);
          reportAgentWrite(writeAgentFile(firewall, fullPath, mod.content, 'verify', changes), mod.filePath);
        } catch (e: any) {
          console.log(chalk.red(`     ✖ Failed to process ${mod.filePath}: ${e.message}`));
        }
      }
    }
    
    iteration++;
  }

  const requirements = specRequirementCoverage(process.cwd());
  if (requirements) metricsEngine.setRequirements(requirements.covered, requirements.total, 'specification-traceability');

  const logPath = metricsEngine.saveExecutionLog(execEvents, execErrors);
  console.log(chalk.bold.cyan(`\n📊 Closed-Loop Execution metrics saved to: ${logPath}`));

  if (!success) {
    process.exitCode = drift ? ExitCode.DRIFT : ExitCode.GATE_FAILED;
  }
  } finally {
    // Whatever ended the loop (retry limit, circuit breaker, a stop rule, an error), the agent's changes do
    // not stay behind unless they made the tests pass.
    if (!testsPassed && changes.size) {
      const undone = changes.rollback();
      console.log(chalk.yellow(`\n   ↺ Rolled back the agent's changes: ${undone.restored.length} file(s) restored, ${undone.removed.length} created file(s) removed.`));
      for (const f of undone.failed) console.log(chalk.red(`   ✖ Could not roll back ${f.file}: ${f.error}`));
    }
    if (services) {
      services.stop();
      console.log(chalk.gray('   Integration services stopped.'));
    }
  }
}
