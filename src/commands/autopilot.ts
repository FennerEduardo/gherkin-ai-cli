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

  let specContent = 'Feature: Auto-generated feature...';
  if (specRes.codeModifications && specRes.codeModifications.length > 0) {
    for (const mod of specRes.codeModifications) {
      const p = mod.filePath.endsWith('.feature') ? mod.filePath : `specs/${mod.filePath}`;
      const fullPath = path.resolve(p);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, mod.content);
      console.log(chalk.green(`   ✓ Wrote specification to ${p}`));
      if (mod.filePath.endsWith('.feature')) {
        specContent = mod.content;
      }
    }
  } else {
    console.log(chalk.yellow(`   ⚠️ Agent didn't return proper code blocks. Using fallback.`));
  }

  console.log(chalk.blue(`3. Invoking Scaffolding Agent -> Generating Bindings...`));
  const scaffoldRes = await agent.executeTask({
    id: 'auto-scaffold',
    type: 'scaffold_binding',
    prompt: `Generate step definitions for the following spec:\n\n${specContent}\n\nWrap code in \`\`\`ts ... \`\`\``,
    contextFiles: []
  });

  if (scaffoldRes.codeModifications && scaffoldRes.codeModifications.length > 0) {
    for (const mod of scaffoldRes.codeModifications) {
      const fullPath = path.resolve(mod.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, mod.content);
      console.log(chalk.green(`   ✓ Wrote bindings to ${mod.filePath}`));
    }
  }

  console.log(chalk.blue(`4. Invoking Verification Agent & Closed-Loop Repair...`));
  await handleVerifyCommand({ autoFix: true, maxRetries: 2 });

  console.log(chalk.blue(`5. Evaluating Enterprise Quality Score Gate...`));
  const scorecard = calculateQualityScorecard();
  console.log(chalk.bold.green(`\n✅ Autopilot Execution Complete! Quality Score: ${scorecard.overallScore}%`));
  console.log(chalk.bold.cyan(`   Ready for PR Review & Human Approval.\n`));
}
