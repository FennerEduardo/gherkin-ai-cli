/* ==========================================================================
   gherkin-ai-cli - 'converge' Command Handler
   ========================================================================== */

import { emitJson } from '../utils/output';
import { ExitCode, UsageError } from '../core/errors';
import { parseApiDocument } from '../core/contract-drift';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { parseGherkinText } from '../core/gherkin-parser';
import { calculateConvergence, ConvergenceReport } from '../core/convergence-engine';
import { forEachProjectFeature, formatFeatureTable, projectFeatureFiles } from '../core/workspace-projects';

export interface ConvergeCommandOptions {
  feature?: string;
  threshold?: string;
  json?: boolean;
  /** Every feature of every project under the working directory. */
  all?: boolean;
  /** OpenAPI document the running service serves: a file, or an http(s) URL such as http://localhost:8080/v3/api-docs. */
  live?: string;
  /** Fail when the feature names a state that no enum of the contracts lists. */
  strictContracts?: boolean;
}

/** Reads the live OpenAPI document from a file or a URL. */
async function readLiveDocument(source: string): Promise<unknown> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(15000) }).catch((e: Error) => {
      throw new UsageError(`Cannot fetch the live OpenAPI document from ${source}: ${e.message}`, { hint: 'Start the service, or export its document to a file and pass the file.' });
    });
    if (!res.ok) throw new UsageError(`Cannot fetch the live OpenAPI document from ${source}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    if (!fs.existsSync(source)) throw new UsageError(`Live OpenAPI document not found: ${source}`);
    text = fs.readFileSync(source, 'utf8');
  }
  try {
    return parseApiDocument(text);
  } catch (e: any) {
    throw new UsageError(`The live document ${source} is not JSON or YAML: ${e.message}`);
  }
}

export async function handleConvergeCommand(options: ConvergeCommandOptions = {}): Promise<void> {
  const threshold = parseInt(options.threshold || '80', 10);
  if (options.live && options.all) throw new UsageError('--live compares one service with its document: use it with a single project, not --all.');
  const engineOptions = { live: options.live ? await readLiveDocument(options.live) : undefined, strictContracts: options.strictContracts };

  if (options.all) {
    // Every feature of every gherkin-ai project under the working directory (monorepos).
    const rows = forEachProjectFeature(process.cwd(), (projectDir, file) => {
      const report = calculateConvergence(parseGherkinText(fs.readFileSync(file, 'utf8')), file, projectDir, engineOptions);
      return { score: report.overallConvergence, passed: report.overallConvergence >= threshold && !report.contractDrift, status: report.contractDrift ? 'DRIFT' : report.status };
    });
    if (options.json) emitJson(rows);
    else {
      console.log(chalk.bold.cyan(`\n🔄 Convergence across ${new Set(rows.map(r => r.project)).size} project(s), threshold ${threshold}%\n`));
      console.log(formatFeatureTable(rows, 'Convergence'));
      console.log('');
    }
    if (rows.length === 0 || rows.some(r => !r.passed)) process.exitCode = ExitCode.DRIFT;
    if (rows.length === 0 && !options.json) console.log(chalk.yellow('⚠ No gherkin-ai projects with feature files found.\n'));
    return;
  }

  // Resolve feature files
  let featureFiles: string[] = [];

  if (options.feature) {
    featureFiles = [path.resolve(options.feature)];
  } else {
    try {
      featureFiles = projectFeatureFiles(process.cwd());
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

    const report = calculateConvergence(parsed, file, process.cwd(), engineOptions);
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

      const notMeasured = dim.applicable === false;
      const bar = notMeasured ? chalk.gray('·'.repeat(barWidth)) : barColor('█'.repeat(filledWidth)) + chalk.gray('░'.repeat(emptyWidth));
      const scoreStr = notMeasured ? ' n/a' : `${dim.score}%`.padStart(4);

      // The basis says whether a score is checked against artifacts, test reports, or the spec alone.
      console.log(`     ${dim.name.padEnd(25)} ${bar}  ${barColor(scoreStr)}  ${chalk.gray(dim.basis ?? '')}`);

      if (dim.status !== 'pass') {
        for (const detail of dim.details.slice(0, 2)) {
          console.log(chalk.gray(`       ↳ ${detail}`));
        }
      }
    }

    for (const check of report.contractChecks ?? []) {
      const mark = check.passed ? chalk.green('✓ pass') : check.gating ? chalk.red('✖ FAIL') : chalk.yellow('⚠ warn');
      console.log(`     ${`Contract: ${check.check}`.padEnd(25)} ${mark}`);
      for (const finding of check.findings.slice(0, 5)) console.log(chalk.gray(`       ↳ ${finding}`));
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

  const drift = allReports.some(r => r.contractDrift);
  if (options.json) {
    emitJson(allReports);
    if (drift || (allReports.length > 0 && Math.round(totalConvergence / allReports.length) < threshold)) process.exitCode = ExitCode.DRIFT;
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

  if (drift) console.log(chalk.red.bold('  Contract drift: the feature, the contracts and the service disagree (see the contract checks above).\n'));
  if (avgConvergence < threshold || drift) {
    process.exitCode = ExitCode.DRIFT;
  }
}
