/* ==========================================================================
   gherkin-ai-cli - 'verify' Command Handler (Closed-Loop Verification Engine)
   ========================================================================== */

import chalk from 'chalk';
import { executeSandbox, SandboxExecutionOptions } from '../core/execution-sandbox';
import { parseExecutionFailure } from '../core/error-parser';
import { DefaultCliAgentProvider } from '../core/agent-adapter';

export interface VerifyCommandOptions {
  autoFix?: boolean;
  docker?: boolean;
  maxRetries?: string | number;
  command?: string;
}

export async function handleVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔁 Executing Closed-Loop Verification Pipeline...\n'));

  const maxRetries = parseInt(String(options.maxRetries || '3'), 10);
  const sandboxOpts: SandboxExecutionOptions = {
    command: options.command,
    docker: options.docker || false
  };

  let iteration = 1;
  let success = false;

  while (iteration <= maxRetries && !success) {
    console.log(chalk.bold.blue(`[Iteration ${iteration}/${maxRetries}] Running Test Harness...`));
    
    const result = executeSandbox(sandboxOpts);

    if (result.success) {
      console.log(chalk.bold.green(`\n✅ Suite Verification Passed! (Duration: ${result.durationMs}ms)`));
      console.log(chalk.green(`   Executed command: ${result.commandExecuted}\n`));
      success = true;
      break;
    }

    console.log(chalk.bold.yellow(`\n❌ Execution Failed (Exit Code: ${result.exitCode})`));
    const diagnosis = parseExecutionFailure(result);

    console.log(chalk.yellow(`   Diagnosis: ${diagnosis.summary}`));
    if (diagnosis.affectedFiles.length > 0) {
      console.log(chalk.gray(`   Affected files: ${diagnosis.affectedFiles.join(', ')}`));
    }

    if (!options.autoFix) {
      console.log(chalk.gray('\n   Tip: Re-run with --auto-fix to invoke agent self-healing repair loops.\n'));
      process.exitCode = result.exitCode;
      return;
    }

    if (iteration === maxRetries) {
      console.log(chalk.bold.red(`\n✖ Auto-fix retry limit reached (${maxRetries} attempts). Fix manually.\n`));
      process.exitCode = result.exitCode;
      return;
    }

    console.log(chalk.cyan(`\n🤖 Invoking Agent Repair Loop (Attempt ${iteration})...`));
    const agent = new DefaultCliAgentProvider();
    const repairResult = await agent.executeTask({
      id: `fix-${iteration}`,
      type: 'auto_fix',
      prompt: diagnosis.suggestedFixContext,
      contextFiles: diagnosis.affectedFiles,
      diagnosis
    });

    console.log(chalk.gray(`   ${repairResult.agentResponse.split('\n')[0]}`));
    iteration++;
  }

  if (!success) {
    process.exitCode = 1;
  }
}
