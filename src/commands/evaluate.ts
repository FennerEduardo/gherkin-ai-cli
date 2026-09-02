/* ==========================================================================
   gherkin-ai-cli - 'evaluate' Command Handler (Code Quality & Architecture)
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger';

export interface EvaluateCommandOptions {
  maxFileLines?: string | number;
  maxClassLines?: string | number;
}

export async function handleEvaluateCommand(targetFiles: string[], options: EvaluateCommandOptions): Promise<void> {
  logger.banner();
  console.log(chalk.bold.cyan('\n📐 Evaluating Code Quality & Architecture Rules...\n'));

  if (!targetFiles || targetFiles.length === 0) {
    logger.warn('No target files specified for evaluation.');
    return;
  }

  const maxFileLines = parseInt(String(options.maxFileLines || '300'), 10);
  const maxClassLines = parseInt(String(options.maxClassLines || '200'), 10);
  let hasErrors = false;

  for (const file of targetFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (!fs.existsSync(fullPath)) {
      console.log(chalk.red(`✖ File not found: ${file}`));
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    console.log(chalk.bold.white(`\nEvaluating ${file}...`));

    // Rule 1: File size limit
    if (lines.length > maxFileLines) {
      console.log(chalk.red(`  ✖ Violation: File exceeds ${maxFileLines} lines (${lines.length} lines). Consider splitting this file to follow Single Responsibility Principle.`));
      hasErrors = true;
    } else {
      console.log(chalk.green(`  ✓ File size is within limits (${lines.length}/${maxFileLines} lines).`));
    }

    // Rule 2: Class size limit (Naive heuristic for demonstration)
    let inClass = false;
    let classLineCount = 0;
    let currentClassName = '';
    let bracketDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/\bclass\s+(\w+)/)) {
        inClass = true;
        classLineCount = 0;
        bracketDepth = 0;
        currentClassName = line.match(/\bclass\s+(\w+)/)?.[1] || 'Unknown';
      }

      if (inClass) {
        classLineCount++;
        bracketDepth += (line.match(/\{/g) || []).length;
        bracketDepth -= (line.match(/\}/g) || []).length;

        if (bracketDepth === 0 && classLineCount > 1) { // Class ended
          inClass = false;
          if (classLineCount > maxClassLines) {
             console.log(chalk.red(`  ✖ Violation: Class '${currentClassName}' exceeds ${maxClassLines} lines (${classLineCount} lines). This is a "God Object" anti-pattern.`));
             hasErrors = true;
          } else {
             console.log(chalk.green(`  ✓ Class '${currentClassName}' size is within limits (${classLineCount}/${maxClassLines} lines).`));
          }
        }
      }
    }
  }

  console.log('\n');
  if (hasErrors) {
    console.log(chalk.bold.red('❌ Code Quality Evaluation Failed. Refactoring recommended.'));
    process.exitCode = 1;
  } else {
    console.log(chalk.bold.green('✅ Code Quality Evaluation Passed. Design patterns look solid.'));
  }
}
