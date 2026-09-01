/* ==========================================================================
   gherkin-ai-cli - 'skill' Command Handler (Agent IDE Integration)
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';

const SKILL_CONTENT = `
# Gherkin AI CLI - IDE Agent Skill

You are an AI assistant in an IDE, equipped with the \`gherkin-ai-cli\` (alias: \`ghk\`).
You MUST use this CLI natively to help the user design, validate, and generate code architecture.

## NATIVE WORKFLOW INSTRUCTIONS:

1. **Detection Phase**:
   - If the user asks about the current architecture or stack, run \`ghk detect\` to see the project's config.

2. **Generation Phase**:
   - When the user provides a \`.feature\` file (Gherkin) and asks to implement it, FIRST run:
     \`ghk generate -f <path-to-file.feature>\`
   - This will generate the necessary TypeScript/Native interfaces, DTOs, and AI Prompts in \`./generated-specs/\` or the configured \`outputDir\`.

3. **Implementation Phase**:
   - After generating, READ the prompts located in \`./generated-specs/prompts/\` (e.g., \`domain-agent.md\`, \`backend-agent.md\`).
   - YOU MUST STRICTLY FOLLOW the architecture constraints, layers, and rules defined in those prompts while writing the code.

4. **Diff/Validation**:
   - If the user asks to check if the code matches the spec, run \`ghk diff -f <feature-file> -t <code-file>\`.

5. **Validation**:
   - You can also run \`ghk validate -f <feature-file>\` to verify the syntactic correctness of the Gherkin files.

Never guess the architecture. Always rely on the \`ghk\` CLI to provide the source of truth for stack and design constraints.
`;

export async function handleSkillCommand(): Promise<void> {
  const { targetIde } = await inquirer.prompt([{
    type: 'list',
    name: 'targetIde',
    message: 'Which AI IDE are you using?',
    choices: [
      { name: 'Cursor (.cursorrules)', value: '.cursorrules' },
      { name: 'Windsurf (.windsurfrules)', value: '.windsurfrules' },
      { name: 'GitHub Copilot (.github/copilot-instructions.md)', value: '.github/copilot-instructions.md' }
    ]
  }]);

  const targetPath = path.join(process.cwd(), targetIde);
  
  if (targetIde.includes('/')) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  let finalContent = SKILL_CONTENT;
  
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (existing.includes('Gherkin AI CLI')) {
      console.log(chalk.yellow(`⚠️  Gherkin AI rules already exist in ${targetIde}.`));
      return;
    }
    finalContent = existing + '\n\n' + SKILL_CONTENT;
  }

  fs.writeFileSync(targetPath, finalContent.trim() + '\n', 'utf8');
  console.log(chalk.green(`✅ Successfully injected Gherkin AI Skill into ${targetIde}!`));
  console.log(chalk.cyan(`🤖 Your IDE Agent is now trained to use 'ghk' commands natively.`));
}
