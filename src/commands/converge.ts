/* ==========================================================================
   gherkin-ai-cli - 'converge' Command Handler
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { parseGherkinText } from '../core/gherkin-parser';
import { calculateConvergence, ConvergenceReport } from '../core/convergence-engine';

export interface ConvergeCommandOptions {
  feature?: string;
  threshold?: string;
  json?: boolean;
}

export async function handleConvergeCommand(options: ConvergeCommandOptions = {}): Promise<void> {
  const threshold = parseInt(options.threshold || '80', 10);

  // Resolve feature files
  let featureFiles: string[] = [];

  if (options.feature) {
    featureFiles = [path.resolve(options.feature)];
  } else {
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
    console.log(chalk.yellow('\n⚠ No .feature files found to analyze.\n'));
    return;
  }

  console.log(chalk.bold.cyan('\n🔄 Running Convergence Analysis...\n'));

  const allReports: ConvergenceReport[] = [];
  let totalConvergence = 0;

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

    const report = calculateConvergence(parsed, file);
    allReports.push(report);
    totalConvergence += report.overallConvergence;

    if (options.json) continue;

    // Display convergence report
    const statusColor = report.status === 'CONVERGED' ? chalk.green :
                        report.status === 'PARTIAL' ? chalk.yellow : chalk.red;
    const statusIcon = report.status === 'CONVERGED' ? '✓' :
                       report.status === 'PARTIAL' ? '⚠' : '✖';

    console.log(chalk.bold(`  📄 ${path.basename(file)} — ${report.featureName}`));
    console.log('');

    // Dimension bars
    for (const dim of report.dimensions) {
      const barWidth = 30;
      const filledWidth = Math.round((dim.score / 100) * barWidth);
      const emptyWidth = barWidth - filledWidth;

      const barColor = dim.status === 'pass' ? chalk.green :
                       dim.status === 'warn' ? chalk.yellow : chalk.red;

      const bar = barColor('█'.repeat(filledWidth)) + chalk.gray('░'.repeat(emptyWidth));
      const scoreStr = `${dim.score}%`.padStart(4);

      console.log(`     ${dim.name.padEnd(25)} ${bar}  ${barColor(scoreStr)}`);

      if (dim.status !== 'pass') {
        for (const detail of dim.details.slice(0, 2)) {
          console.log(chalk.gray(`       ↳ ${detail}`));
        }
      }
    }

    console.log('');
    console.log(`     ${'Overall Convergence'.padEnd(25)} ${statusColor.bold(`${report.overallConvergence}%`)}  ${statusColor(`[${report.status}]`)}`);

    if (report.recommendations.length > 0) {
      console.log('');
      console.log(chalk.cyan('     Recommendations:'));
      for (const rec of report.recommendations) {
        console.log(chalk.cyan(`       → ${rec}`));
      }
    }

    console.log('');
    console.log(chalk.gray('  ' + '─'.repeat(70)));
    console.log('');
  }

  if (options.json) {
    console.log(JSON.stringify(allReports, null, 2));
    return;
  }

  // Overall summary
  const avgConvergence = allReports.length > 0 ? Math.round(totalConvergence / allReports.length) : 0;
  const overallStatus = avgConvergence >= threshold ? chalk.green.bold('PASSED ✓') : chalk.red.bold('FAILED ✖');
  const overallColor = avgConvergence >= 80 ? chalk.green : avgConvergence >= 60 ? chalk.yellow : chalk.red;

  console.log(chalk.bold('═'.repeat(60)));
  console.log(`  ${chalk.bold('Overall Convergence:')} ${overallColor.bold(`${avgConvergence}%`)} (threshold: ${threshold}%)`);
  console.log(`  ${chalk.bold('Status:')} ${overallStatus}`);
  console.log(`  ${chalk.bold('Features Analyzed:')} ${allReports.length}`);
  console.log(chalk.bold('═'.repeat(60)));
  console.log('');

  if (avgConvergence < threshold) {
    process.exitCode = 1;
  }
}
