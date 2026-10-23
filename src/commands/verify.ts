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
import { resolve as resolvePath } from 'path';
import { readFileSync } from 'fs';
import { calculateConvergence } from '../core/convergence-engine';
import { parseGherkinText } from '../core/gherkin-parser';
import { projectFeatureFiles } from '../core/workspace-projects';
import { DEFAULT_CONTAINER_LIMITS, executeSandbox, SandboxExecutionOptions } from '../core/execution-sandbox';
import { resolveToolchain } from '../generators/toolchains';
import { parseExecutionFailure } from '../core/error-parser';
import { planDeterministicRepair } from '../core/deterministic-repair';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
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
  command?: string;
  allowUnattendedWrites?: boolean;
  forceBranch?: boolean;
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

export async function handleVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔁 Executing Closed-Loop Verification Pipeline...\n'));

  const maxRetries = parseInt(String(options.maxRetries || '3'), 10);
  const config = loadConfig();
  if (options.autoFix && process.env.GHK_DRY_RUN !== 'true') {
    assertAgentWritesAllowed(config, { command: 'verify', allowUnattendedWrites: options.allowUnattendedWrites, forceBranch: options.forceBranch });
  }
  const firewall = AgentFirewall.forWorkspace(process.cwd(), config);
  // --isolated used to write its own docker-compose.test.yml with older images; it is now --services.
  if (options.isolated) {
    console.log(chalk.yellow('   --isolated is deprecated: it runs as --services (the same containers as the golden builds).'));
    options.services = true;
  }
  // --services runs the runtime integration suite in the toolchain container against real PostgreSQL and the broker.
  if (options.services) options.docker = true;
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
    profile: options.services ? 'toolchain' : 'strict'
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
  const fileBackups: Record<string, string> = {};
  let guardrailViolationPrompt: string | null = null;
  const metricsEngine = new MetricsEngine();
  const execEvents: any[] = [];
  const execErrors: any[] = [];
  const previousPatchHashes = new Set<string>();

  const fs = require('fs');
  const path = require('path');
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
      console.log(chalk.bold.red(`\n✖ Auto-fix retry limit reached (${maxRetries} attempts). Initiating rollback...\n`));
      
      const fs = require('fs');
      const backupKeys = Object.keys(fileBackups);
      if (backupKeys.length > 0) {
        console.log(chalk.yellow(`   The agent failed to fix the tests. The following ${backupKeys.length} files were modified and will be reverted:`));
        for (const [filePath, backupPath] of Object.entries(fileBackups)) {
          try {
            if (fs.existsSync(backupPath)) {
              fs.copyFileSync(backupPath, filePath);
              console.log(chalk.yellow(`   ↺ Rolled back: ${filePath}`));
            }
          } catch (e: any) {
            console.log(chalk.red(`   ✖ Failed to rollback ${filePath}: ${e.message}`));
          }
        }
      } else {
        console.log(chalk.gray(`   No files were modified during the attempts. Nothing to rollback.`));
      }
      
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
    const { resolveLLMConfig } = require('../core/agent-adapter');
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
      const crypto = require('crypto');
      const patchHash = crypto.createHash('sha256').update(JSON.stringify(repairResult.codeModifications)).digest('hex');

      if (previousPatchHashes.has(patchHash)) {
        console.log(chalk.bold.red(`\n⚡ CIRCUIT BREAKER TRIPPED: Agent proposed the exact same code modifications as a previous iteration. Aborting to prevent infinite loop.`));
        success = false;
        break;
      }
      previousPatchHashes.add(patchHash);

      const { validateGuardrails } = require('../core/guardrails');
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
      
      const guardrailValidation = validateGuardrails({
        action: 'generate_code',
        targetFiles: proposedFiles
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
          const fs = require('fs');
          const path = require('path');
          const { validateTypeScriptSyntax } = require('../core/syntax-validator');
          
          if (!validateTypeScriptSyntax(mod.filePath, mod.content)) {
            console.log(chalk.yellow(`     ✖ Skipped writing ${mod.filePath} due to syntax errors.`));
            continue;
          }

          if (process.env.GHK_DRY_RUN === 'true') {
            if (process.env.GHK_STDOUT === 'true') {
              console.log(chalk.yellow(`     [DRY RUN] Proposed changes for ${mod.filePath}:\n${mod.content}`));
            } else {
              const fs = require('fs');
              const path = require('path');
              const patchDir = path.resolve('.ghe', 'patches');
              fs.mkdirSync(patchDir, { recursive: true });
              
              // We'll just save the proposed file for now instead of a real git patch
              // as this is safer and doesn't require git/diff CLI
              const patchPath = path.join(patchDir, path.basename(mod.filePath) + '.proposed');
              fs.writeFileSync(patchPath, mod.content, 'utf8');
              console.log(chalk.yellow(`     [DRY RUN] Saved proposed file to ${patchPath}`));
            }
            continue;
          }

          const { resolveSafePath } = require('../utils/file-system');
          const fullPath = resolveSafePath(process.cwd(), mod.filePath);
          
          if (!fileBackups[fullPath] && fs.existsSync(fullPath)) {
             const backupDir = path.resolve('.ghe', 'backups');
             fs.mkdirSync(backupDir, { recursive: true });
             const hash = crypto.createHash('md5').update(fullPath).digest('hex');
             const backupPath = path.join(backupDir, `${path.basename(fullPath)}.${hash}.bak`);
             fs.copyFileSync(fullPath, backupPath);
             fileBackups[fullPath] = backupPath;
          }
          
          reportAgentWrite(writeAgentFile(firewall, fullPath, mod.content, 'verify'), mod.filePath);
        } catch (e: any) {
          console.log(chalk.red(`     ✖ Failed to process ${mod.filePath}: ${e.message}`));
        }
      }
    }
    
    iteration++;
  }

  // Set mock requirements since this is just the verify command
  // In a real scenario, this would be passed down from the parsed features
  metricsEngine.setRequirements(success ? 10 : 0, 10);
  
  const logPath = metricsEngine.saveExecutionLog(execEvents, execErrors);
  console.log(chalk.bold.cyan(`\n📊 Closed-Loop Execution metrics saved to: ${logPath}`));

  if (!success) {
    process.exitCode = drift ? ExitCode.DRIFT : ExitCode.GATE_FAILED;
  }
  } finally {
    if (services) {
      services.stop();
      console.log(chalk.gray('   Integration services stopped.'));
    }
  }
}
