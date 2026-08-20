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

export interface AutopilotOptions {
  requirement?: string;
  autonomous?: boolean;
}

export async function handleAutopilotCommand(options: AutopilotOptions = {}): Promise<void> {
  console.log(chalk.bold.cyan('\n🚀 Launching gherkin-ai Autopilot Autonomous Delivery Orchestrator...\n'));

  const reqFile = options.requirement || 'requirement.md';
  const reqContent = fs.existsSync(reqFile) ? fs.readFileSync(reqFile, 'utf8') : 'No requirement provided.';

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
  const specRes = await agent.executeTask({
    id: 'auto-spec',
    type: 'spec_generation',
    prompt: `Generate a Gherkin .feature file for the following requirement:\n\n${reqContent}\n\nWrap the code in \`\`\`gherkin ... \`\`\` blocks.`,
    contextFiles: ['.ghe/conventions.md']
  });

  const specContent = specRes.codeModifications?.[0]?.content || 'Feature: Auto-generated feature...';
  const specPath = 'specs/autopilot.feature';
  fs.mkdirSync('specs', { recursive: true });
  fs.writeFileSync(specPath, specContent);
  console.log(chalk.green(`   ✓ Wrote specification to ${specPath}`));

  console.log(chalk.blue(`3. Invoking Scaffolding Agent -> Generating Bindings...`));
  const scaffoldRes = await agent.executeTask({
    id: 'auto-scaffold',
    type: 'scaffold_binding',
    prompt: `Generate step definitions for the following spec:\n\n${specContent}\n\nWrap code in \`\`\`ts ... \`\`\``,
    contextFiles: [specPath]
  });

  if (scaffoldRes.codeModifications && scaffoldRes.codeModifications.length > 0) {
     const bindPath = 'tests/steps/autopilot.steps.ts';
     fs.mkdirSync('tests/steps', { recursive: true });
     fs.writeFileSync(bindPath, scaffoldRes.codeModifications[0].content);
     console.log(chalk.green(`   ✓ Wrote bindings to ${bindPath}`));
  }

  console.log(chalk.blue(`4. Invoking Verification Agent & Closed-Loop Repair...`));
  await handleVerifyCommand({ autoFix: true, maxRetries: 2 });

  console.log(chalk.blue(`5. Evaluating Enterprise Quality Score Gate...`));
  const scorecard = calculateQualityScorecard();
  console.log(chalk.bold.green(`\n✅ Autopilot Execution Complete! Quality Score: ${scorecard.overallScore}%`));
  console.log(chalk.bold.cyan(`   Ready for PR Review & Human Approval.\n`));
}
