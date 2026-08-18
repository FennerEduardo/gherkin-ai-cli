/* ==========================================================================
   gherkin-ai-cli - 'context' Command Handler
   ========================================================================== */

import chalk from 'chalk';
import { buildProjectContext } from '../core/context-builder';

export async function handleContextCommand(subcommand?: string): Promise<void> {
  console.log(chalk.bold.cyan('\n📦 Building Agent Context Bundle (.ghe/)...\n'));

  const context = buildProjectContext();
  console.log(chalk.green(`  ✔ Detected ${context.detectedFiles.length} workspace source files.`));
  console.log(chalk.green(`  ✔ Loaded project configuration & convention rules.`));
  console.log(chalk.bold.green(`\n🎉 Context package generated at .ghe/ (Timestamp: ${context.builtAt})\n`));
}
