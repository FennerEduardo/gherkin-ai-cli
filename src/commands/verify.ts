/* ==========================================================================
   gherkin-ai-cli - 'verify' Command Handler (Closed-Loop Verification Engine)
   ========================================================================== */

import chalk from 'chalk';
import { executeSandbox, SandboxExecutionOptions } from '../core/execution-sandbox';
import { parseExecutionFailure } from '../core/error-parser';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
import { loadConfig } from '../core/config';

export interface VerifyCommandOptions {
  autoFix?: boolean;
  docker?: boolean;
  maxRetries?: string | number;
  command?: string;
}

export async function handleVerifyCommand(options: VerifyCommandOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🔁 Executing Closed-Loop Verification Pipeline...\n'));

  const maxRetries = parseInt(String(options.maxRetries || '3'), 10);
  const config = loadConfig();
  const sandboxOpts: SandboxExecutionOptions = {
    command: options.command,
    configCommand: config.testCommand,
    docker: options.docker || false
  };

  let iteration = 1;
  let success = false;
  const fileBackups: Record<string, string> = {};
  let guardrailViolationPrompt: string | null = null;

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

    console.log(chalk.gray(`   ${repairResult.agentResponse.split('\n')[0]}`));
    
    // Apply Code Modifications if provided by RealAgentProvider
    if (repairResult.codeModifications && repairResult.codeModifications.length > 0) {
      const { validateGuardrails } = require('../core/guardrails');
      const proposedFiles = repairResult.codeModifications.map((m: any) => m.filePath);
      
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
          const crypto = require('crypto');
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
          
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, mod.content, 'utf8');
          console.log(chalk.green(`     ✓ ${mod.filePath} updated.`));
        } catch (e: any) {
          console.log(chalk.red(`     ✖ Failed to process ${mod.filePath}: ${e.message}`));
        }
      }
    }
    
    iteration++;
  }

  if (!success) {
    process.exitCode = 1;
  }
}
