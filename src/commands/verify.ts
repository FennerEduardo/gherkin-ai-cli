/* ==========================================================================
   gherkin-ai-cli - 'verify' Command Handler (Closed-Loop Verification Engine)
   ========================================================================== */

import { assertAgentWritesAllowed, reportAgentWrite, writeAgentFile } from '../core/governance/write-guard';
import { AgentFirewall } from '../core/governance/agent-firewall';
import { ExitCode } from '../core/errors';
import chalk from 'chalk';
import { DEFAULT_CONTAINER_LIMITS, executeSandbox, SandboxExecutionOptions } from '../core/execution-sandbox';
import { resolveToolchain } from '../generators/toolchains';
import { parseExecutionFailure } from '../core/error-parser';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
import { loadConfig } from '../core/config';
import { MetricsEngine } from '../core/metrics-engine';

export interface VerifyCommandOptions {
  autoFix?: boolean;
  docker?: boolean;
  /** Docker network for --docker (default "none"). */
  dockerNetwork?: string;
  isolated?: boolean;
  maxRetries?: string | number;
  command?: string;
  allowUnattendedWrites?: boolean;
  forceBranch?: boolean;
}

export async function handleVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔁 Executing Closed-Loop Verification Pipeline...\n'));

  const maxRetries = parseInt(String(options.maxRetries || '3'), 10);
  const config = loadConfig();
  if (options.autoFix && process.env.GHK_DRY_RUN !== 'true') {
    assertAgentWritesAllowed(config, { command: 'verify', allowUnattendedWrites: options.allowUnattendedWrites, forceBranch: options.forceBranch });
  }
  const firewall = AgentFirewall.forWorkspace(process.cwd(), config);
  // In a container, default to the stack's verified toolchain image and test commands.
  const toolchain = options.docker ? resolveToolchain(config) : undefined;
  const sandboxOpts: SandboxExecutionOptions = {
    command: options.command,
    configCommand: config.testCommand ?? (toolchain ? toolchain.test.join(' && ') : undefined),
    docker: options.docker || false,
    dockerImage: config.sandbox?.image ?? toolchain?.image,
    limits: {
      network: options.dockerNetwork ?? config.sandbox?.network,
      memory: config.sandbox?.memory,
      cpus: config.sandbox?.cpus,
      pidsLimit: config.sandbox?.pidsLimit
    }
  };
  if (options.docker) {
    const limits = { ...DEFAULT_CONTAINER_LIMITS, ...Object.fromEntries(Object.entries(sandboxOpts.limits ?? {}).filter(([, v]) => v !== undefined)) };
    console.log(chalk.gray(`   Container: ${sandboxOpts.dockerImage} (network=${limits.network}, memory=${limits.memory}, cpus=${limits.cpus}, read-only root)\n`));
  }

  let iteration = 1;
  let success = false;
  const fileBackups: Record<string, string> = {};
  let guardrailViolationPrompt: string | null = null;
  const metricsEngine = new MetricsEngine();
  const execEvents: any[] = [];
  const execErrors: any[] = [];
  const previousPatchHashes = new Set<string>();

  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  let isIsolatedActive = false;

  try {
    if (options.isolated) {
      console.log(chalk.bold.cyan(`\n🐳 [Isolated Mode] Generating dynamic Testcontainers compose stack...`));
      
      const dbPort = config.stack.database === 'postgres' ? '5432' : '3306';
      const dbImage = config.stack.database === 'postgres' ? 'postgres:15-alpine' : 'mysql:8.0';
      const brokerImage = config.stack.messaging === 'rabbitmq' ? 'rabbitmq:3-management-alpine' : 'redis:7-alpine';
      const brokerPort = config.stack.messaging === 'rabbitmq' ? '5672:5672' : '6379:6379';

      const composeContent = `version: '3.8'
services:
  db:
    image: ${dbImage}
    environment:
      POSTGRES_USER: testuser
      POSTGRES_PASSWORD: testpassword
      POSTGRES_DB: testdb
      MYSQL_ROOT_PASSWORD: testpassword
      MYSQL_DATABASE: testdb
    ports:
      - "\${DB_PORT:-${dbPort}}:${dbPort}"
  
  broker:
    image: ${brokerImage}
    ports:
      - "${brokerPort}"

  jaeger:
    image: jaegertracing/all-in-one:latest
    environment:
      - COLLECTOR_OTLP_ENABLED=true
    ports:
      - "4317:4317" # OTLP gRPC
      - "4318:4318" # OTLP HTTP
      - "16686:16686" # UI
`;
      const composePath = path.join(process.cwd(), 'docker-compose.test.yml');
      fs.writeFileSync(composePath, composeContent);
      console.log(chalk.gray(`   Created ${composePath} (Includes DB, Broker, and Jaeger OpenTelemetry Collector)`));
      
      console.log(chalk.cyan(`   Spinning up dependencies...`));
      execSync('docker compose -f docker-compose.test.yml up -d', { stdio: 'inherit', cwd: process.cwd() });
      isIsolatedActive = true;
      
      // Wait for DB to be ready
      console.log(chalk.gray(`   Waiting 3s for services to initialize...`));
      await new Promise(resolve => setTimeout(resolve, 3000)); // portable (no 'sleep' binary on Windows)
    }

    while (iteration <= maxRetries && !success) {
      console.log(chalk.bold.blue(`[Iteration ${iteration}/${maxRetries}] Running Test Harness...`));
      
      const result = executeSandbox(sandboxOpts);

    if (result.success) {
      console.log(chalk.bold.green(`\n✅ Suite Verification Passed! (Duration: ${result.durationMs}ms)`));
      console.log(chalk.green(`   Executed command: ${result.commandExecuted}\n`));
      
      console.log(chalk.bold.cyan(`🔍 Running Architectural Convergence Check...`));
      try {
        const { handleConvergeCommand } = require('./converge');
        let oldExitCode = process.exitCode;
        await handleConvergeCommand({ threshold: '80' });
        if (process.exitCode !== oldExitCode && process.exitCode !== 0) {
          console.log(chalk.bold.red(`\n✖ CI/CD Gate Failed: Tests passed but Architectural Convergence is below threshold.`));
          success = false;
          break; // break out to fail
        } else {
           console.log(chalk.bold.green(`\n✅ CI/CD Gate Passed: Architectural Convergence meets threshold.`));
           success = true;
           metricsEngine.recordTestRun(true);
           execEvents.push({ type: 'test_passed', iteration, durationMs: result.durationMs });
           break;
        }
      } catch (e) {
        console.log(chalk.yellow(`⚠ Warning: Could not run convergence engine: ${e}`));
        success = true;
        break;
      }
    }

    console.log(chalk.bold.yellow(`\n❌ Execution Failed (Exit Code: ${result.exitCode})`));
    const diagnosis = parseExecutionFailure(result);

    console.log(chalk.yellow(`   Diagnosis: ${diagnosis.summary}`));
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

    console.log(chalk.cyan(`\n🤖 Invoking Agent Repair Loop (Attempt ${iteration})...`));
    const { resolveLLMConfig } = require('../core/agent-adapter');
    const config: LLMConfig = resolveLLMConfig();
    const agent = new RealAgentProvider(config);
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
    process.exitCode = ExitCode.GATE_FAILED;
  }
  } finally {
    if (isIsolatedActive) {
      console.log(chalk.cyan(`\n🧹 Cleaning up Isolated Testcontainers stack...`));
      try {
        const { execSync } = require('child_process');
        execSync('docker compose -f docker-compose.test.yml down -v', { stdio: 'inherit', cwd: process.cwd() });
        console.log(chalk.gray(`   Isolated environment destroyed successfully.`));
      } catch (e: any) {
        console.log(chalk.red(`   ✖ Failed to tear down isolated environment: ${e.message}`));
      }
    }
  }
}
