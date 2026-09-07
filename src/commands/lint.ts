/* ==========================================================================
   gherkin-ai-cli - 'lint' Command Handler
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { parseGherkinText } from '../core/gherkin-parser';
import { lintSpecification, LintDiagnostic, getAvailableRules } from '../core/specification-linter';
import { loadConstitution } from '../core/constitution';

export interface LintCommandOptions {
  feature?: string;
  threshold?: string;
  rules?: boolean;
  json?: boolean;
}

export async function handleLintCommand(options: LintCommandOptions = {}): Promise<void> {
  // Show available rules
  if (options.rules) {
    console.log(chalk.bold.cyan('\n📋 Available Lint Rules:\n'));
    const rules = getAvailableRules();
    for (const rule of rules) {
      const severityColor = rule.severity === 'error' ? chalk.red :
                            rule.severity === 'warning' ? chalk.yellow : chalk.gray;
      console.log(`  ${chalk.bold(rule.id)}  ${severityColor(rule.severity.padEnd(8))}  ${rule.name}`);
    }
    console.log('');
    return;
  }

  const constitution = loadConstitution();
  const threshold = parseInt(options.threshold || '70', 10);

  // Resolve feature files
  let featureFiles: string[] = [];

  if (options.feature) {
    featureFiles = [path.resolve(options.feature)];
  } else {
    // Auto-discover .feature files
    const { resolveSpecDir } = require('../utils/spec-dir-resolver');
    try {
      const specDir = resolveSpecDir(undefined, process.cwd());
      featureFiles = fs.readdirSync(specDir)
        .filter(f => f.endsWith('.feature'))
        .map(f => path.join(specDir, f));
    } catch (e) {
      console.log(chalk.yellow('\n⚠ No feature files found. Use --feature <file> or ensure a specs/ directory exists.\n'));
      return;
    }
  }

  if (featureFiles.length === 0) {
    console.log(chalk.yellow('\n⚠ No .feature files found to lint.\n'));
    return;
  }

  console.log(chalk.bold.cyan(`\n🔍 Linting ${featureFiles.length} specification(s)...\n`));

  let totalScore = 0;
  let allPassed = true;
  const allResults: any[] = [];

  for (const file of featureFiles) {
    if (!fs.existsSync(file)) {
      console.log(chalk.red(`  ✖ File not found: ${file}`));
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = parseGherkinText(content);
    } catch (e: any) {
      console.log(chalk.red(`  ✖ Parse error in ${path.basename(file)}: ${e.message}`));
      continue;
    }

    const result = lintSpecification(parsed, file, {
      threshold,
      constitution,
    });

    totalScore += result.score;
    if (!result.passed) allPassed = false;

    if (options.json) {
      allResults.push(result);
      continue;
    }

    // Display results
    const scoreColor = result.score >= 80 ? chalk.green :
                       result.score >= 60 ? chalk.yellow : chalk.red;
    const statusIcon = result.passed ? chalk.green('✓') : chalk.red('✖');

    console.log(`  ${statusIcon} ${chalk.bold(path.basename(file))} — ${scoreColor(`${result.score}/100`)}`);

    if (result.diagnostics.length > 0) {
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      const warnings = result.diagnostics.filter(d => d.severity === 'warning');
      const infos = result.diagnostics.filter(d => d.severity === 'info');

      if (errors.length > 0) {
        console.log(chalk.red(`    ${errors.length} error(s):`));
        for (const d of errors) {
          printDiagnostic(d, 'error');
        }
      }
      if (warnings.length > 0) {
        console.log(chalk.yellow(`    ${warnings.length} warning(s):`));
        for (const d of warnings) {
          printDiagnostic(d, 'warning');
        }
      }
      if (infos.length > 0) {
        console.log(chalk.gray(`    ${infos.length} info(s):`));
        for (const d of infos) {
          printDiagnostic(d, 'info');
        }
      }
    } else {
      console.log(chalk.green('    No issues found.'));
    }
    console.log('');
  }

  if (options.json) {
    console.log(JSON.stringify(allResults, null, 2));
    return;
  }

  // Summary
  const avgScore = featureFiles.length > 0 ? Math.round(totalScore / featureFiles.length) : 0;
  const summaryColor = avgScore >= 80 ? chalk.green : avgScore >= 60 ? chalk.yellow : chalk.red;

  console.log(chalk.bold('─'.repeat(60)));
  console.log(`  ${chalk.bold('Average Score:')} ${summaryColor(`${avgScore}/100`)} (threshold: ${threshold})`);
  console.log(`  ${chalk.bold('Status:')} ${allPassed ? chalk.green.bold('PASSED ✓') : chalk.red.bold('FAILED ✖')}`);
  console.log('');

  if (!allPassed) {
    process.exitCode = 1;
  }
}

function printDiagnostic(d: LintDiagnostic, level: string): void {
  const prefix = level === 'error' ? chalk.red('      ✖') :
                 level === 'warning' ? chalk.yellow('      ⚠') :
                 chalk.gray('      ℹ');

  console.log(`${prefix} [${chalk.bold(d.ruleId)}] ${d.message}`);
  if (d.scenario) {
    console.log(chalk.gray(`        Scenario: ${d.scenario}`));
  }
  if (d.suggestion) {
    console.log(chalk.cyan(`        💡 ${d.suggestion}`));
  }
}
