/* ==========================================================================
   gherkin-ai-cli - 'autopilot' Command Handler (Multi-Agent Orchestrator)
   ========================================================================== */

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { buildProjectContext } from '../core/context-builder';
import { calculateQualityScorecard } from '../core/quality-score';
import { RealAgentProvider, LLMConfig } from '../core/agent-adapter';
import { handleVerifyCommand } from './verify';
import { loadConfig } from '../core/config';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { validateRequirement } from '../core/requirement-validator';

export interface AutopilotOptions {
  requirement?: string;
  autonomous?: boolean;
  command?: string;
}

export async function handleAutopilotCommand(options: AutopilotOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🚀 Launching gherkin-ai Autopilot Autonomous Delivery Orchestrator...\n'));

  const reqFile = options.requirement || 'requirement.md';
  if (!fs.existsSync(reqFile)) {
    console.log(chalk.red(`\n✖ Requirement file not found: ${reqFile}`));
    console.log(chalk.yellow(`  → Fix: Provide a valid path with --requirement <file>`));
    console.log(chalk.yellow(`  → Example: ghk autopilot --requirement docs/user-crud.md\n`));
    process.exitCode = 1;
    return;
  }
  const reqContent = fs.readFileSync(reqFile, 'utf8');

  // Validate requirement before proceeding with agents
  const validation = validateRequirement(reqContent);
  if (!validation.isValid) {
    console.log(chalk.red('\n✖ Requirement validation failed:'));
    for (const issue of validation.issues) {
      console.log(chalk.yellow(`  ⚠ ${issue.message}`));
      console.log(chalk.gray(`    → ${issue.suggestion}`));
    }
    process.exitCode = 1;
    return;
  }

  const configInstance = loadConfig();

  console.log(chalk.blue(`1. Analyzing repository & building context package...`));
  const context = buildProjectContext();

  const config: LLMConfig = {
    provider: (process.env.LLM_PROVIDER as any) || 'ide_delegate',
    model: process.env.LLM_MODEL,
    apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL
  };
  const agent = new RealAgentProvider(config);

  console.log(chalk.blue(`2. Invoking Spec Agent -> Generating Gherkin AST...`));
  let specRes;
  try {
    specRes = await agent.executeTask({
      id: 'auto-spec',
      type: 'spec_generation',
      prompt: `Generate a Gherkin .feature file for the following requirement:\n\n${reqContent}\n\nWrap the code in \`\`\`gherkin ... \`\`\` blocks.`,
      contextFiles: ['.ghe/conventions.md']
    });
  } catch (error: any) {
    console.log(chalk.red(`\n✖ Spec Agent execution crashed: ${error.message}`));
    process.exitCode = 1;
    return;
  }

  let specContent = '';
  if (specRes.success && specRes.codeModifications && specRes.codeModifications.length > 0) {
    let specDirPath = process.env.GHK_SPEC_DIR || configInstance.specDir || 'specs';
    try {
      specDirPath = resolveSpecDir(configInstance.specDir);
    } catch {
      // Use fallback if none found (specDirPath retains the fallback value)
    }

    for (const mod of specRes.codeModifications) {
      let p = mod.filePath;
      if (!p.endsWith('.feature')) {
        p = path.join(specDirPath, p);
      } else if (!p.includes('/') && !p.includes('\\')) {
        p = path.join(specDirPath, p);
      }
      const fullPath = path.resolve(p);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, mod.content);
      console.log(chalk.green(`   ✓ Wrote specification to ${p}`));
      if (mod.filePath.endsWith('.feature')) {
        specContent = mod.content;
      }
    }
  } else {
    console.log(chalk.red(`\n✖ Spec Agent failed to generate valid code blocks.`));
    console.log(chalk.yellow(`  Response from Agent:\n${specRes.agentResponse.substring(0, 500)}...\n`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.blue(`3. Invoking Scaffolding Agent -> Generating Bindings...`));
  let scaffoldRes;
  try {
    scaffoldRes = await agent.executeTask({
      id: 'auto-scaffold',
      type: 'scaffold_binding',
      prompt: `Generate step definitions for the following spec:\n\n${specContent}\n\nWrap code in \`\`\`ts ... \`\`\``,
      contextFiles: []
    });
  } catch (error: any) {
    console.log(chalk.red(`\n✖ Scaffolding Agent execution crashed: ${error.message}`));
    process.exitCode = 1;
    return;
  }

  if (scaffoldRes.success && scaffoldRes.codeModifications && scaffoldRes.codeModifications.length > 0) {
    const { validateTypeScriptSyntax } = require('../core/syntax-validator');
    for (const mod of scaffoldRes.codeModifications) {
      if (!validateTypeScriptSyntax(mod.filePath, mod.content)) {
        console.log(chalk.yellow(`     ✖ Skipped writing ${mod.filePath} due to syntax errors.`));
        continue;
      }
      const fullPath = path.resolve(mod.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, mod.content);
      console.log(chalk.green(`   ✓ Wrote bindings to ${mod.filePath}`));
    }
  } else {
    console.log(chalk.red(`\n✖ Scaffolding Agent failed to generate valid code blocks.`));
    console.log(chalk.yellow(`  Response from Agent:\n${scaffoldRes.agentResponse.substring(0, 500)}...\n`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.blue(`4. Invoking Verification Agent & Closed-Loop Repair...`));
  await handleVerifyCommand({ autoFix: true, maxRetries: 2, command: options.command });

  console.log(chalk.blue(`5. Evaluating Enterprise Quality Score Gate...`));
  const scorecard = calculateQualityScorecard(process.cwd(), configInstance.specDir);
  console.log(chalk.bold.green(`\n✅ Autopilot Execution Complete! Quality Score: ${scorecard.overallScore}%`));
  console.log(chalk.bold.cyan(`   Ready for PR Review & Human Approval.\n`));
}
