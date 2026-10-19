/* ==========================================================================
   gherkin-ai-cli - 'lint' Command Handler
   ========================================================================== */

import { emitJson } from '../utils/output';
import { ExitCode } from '../core/errors';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { parseGherkinText } from '../core/gherkin-parser';
import { lintSpecification, LintDiagnostic, getAvailableRules } from '../core/specification-linter';
import { loadConstitution } from '../core/constitution';
import { forEachProjectFeature, formatFeatureTable, projectFeatureFiles } from '../core/workspace-projects';
import { loadResolvedConfig } from '../core/config';
import { allIndustryLintRules, industryForConfig, industryLintOptions } from '../core/profiles/industries';
import { explainIr, renderIrExplanation } from '../core/ir-explain';

/** Industry lint rules of the project in `dir` (none when it declares no industry or its config is unreadable). */
function projectIndustry(dir: string): { label?: string; options: ReturnType<typeof industryLintOptions> } {
  try {
    const config = loadResolvedConfig({ cwd: dir }).config;
    return { label: industryForConfig(config)?.label, options: industryLintOptions(config) };
  } catch (e: any) {
    process.stderr.write(`⚠ Industry lint rules skipped: ${e.message}\n`);
    return { options: { rules: [], disabledRules: [] } };
  }
}

export interface LintCommandOptions {
  feature?: string;
  threshold?: string;
  rules?: boolean;
  json?: boolean;
  /** Every feature of every project under the working directory. */
  all?: boolean;
  /** Show the names the generator will use and where each one comes from (tags, steps, defaults). */
  explainIr?: boolean;
}

export async function handleLintCommand(options: LintCommandOptions = {}): Promise<void> {
  // Show available rules
  if (options.rules) {
    console.log(chalk.bold.cyan('\n📋 Available Lint Rules:\n'));
    const rules = getAvailableRules(allIndustryLintRules());
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

  if (options.all) {
    // Every feature of every gherkin-ai project under the working directory (monorepos).
    const industries = new Map<string, ReturnType<typeof projectIndustry>>();
    const industryOf = (dir: string) => industries.get(dir) ?? industries.set(dir, projectIndustry(dir)).get(dir)!;
    const rows = forEachProjectFeature(process.cwd(), (projectDir, file) => {
      const result = lintSpecification(parseGherkinText(fs.readFileSync(file, 'utf8')), file, { threshold, constitution: loadConstitution(projectDir), ...industryOf(projectDir).options });
      return { score: result.score, passed: result.passed };
    });
    if (options.json) emitJson(rows);
    else {
      console.log(chalk.bold.cyan(`\n🔍 Lint across ${new Set(rows.map(r => r.project)).size} project(s), threshold ${threshold}\n`));
      console.log(formatFeatureTable(rows, 'Score'));
      console.log('');
    }
    if (rows.length === 0 || rows.some(r => !r.passed)) process.exitCode = ExitCode.GATE_FAILED;
    if (rows.length === 0 && !options.json) console.log(chalk.yellow('⚠ No gherkin-ai projects with feature files found.\n'));
    return;
  }

  // Resolve feature files
  let featureFiles: string[] = [];

  if (options.feature) {
    featureFiles = [path.resolve(options.feature)];
  } else {
    // Auto-discover .feature files
    try {
      featureFiles = projectFeatureFiles(process.cwd());
    } catch (e) {
      console.log(chalk.yellow('\n⚠ No feature files found. Use --feature <file> or ensure a specs/ directory exists.\n'));
      return;
    }
  }

  if (featureFiles.length === 0) {
    console.log(chalk.yellow('\n⚠ No .feature files found to lint.\n'));
    return;
  }

  const industry = projectIndustry(process.cwd());
  console.log(chalk.bold.cyan(`\n🔍 Linting ${featureFiles.length} specification(s)${industry.label ? ` (industry: ${industry.label})` : ''}...\n`));

  let totalScore = 0;
  let evaluated = 0;
  let allPassed = true;
  const allResults: any[] = [];

  // A file that cannot be read or parsed fails the run; it is not left out silently.
  const unreadable = (file: string, message: string) => {
    allPassed = false;
    if (options.json) {
      allResults.push({ file, featureName: '', diagnostics: [{ ruleId: 'GHK000', severity: 'error', message }], score: 0, passed: false });
    } else {
      console.log(chalk.red(`  ✖ ${message}`));
    }
  };

  for (const file of featureFiles) {
    if (!fs.existsSync(file)) {
      unreadable(file, `File not found: ${file}`);
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = parseGherkinText(content);
    } catch (e: any) {
      unreadable(file, `Parse error in ${path.basename(file)}: ${e.message}`);
      continue;
    }

    const result = lintSpecification(parsed, file, {
      threshold,
      constitution,
      ...industry.options,
    });

    totalScore += result.score;
    evaluated++;
    if (!result.passed) allPassed = false;

    if (options.json) {
      allResults.push(options.explainIr ? { ...result, ir: explainIr(parsed, file) } : result);
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
    if (options.explainIr) console.log(`\n${renderIrExplanation(explainIr(parsed, path.basename(file)))}`);
    console.log('');
  }

  if (options.json) {
    emitJson(allResults);
    if (!allPassed) process.exitCode = ExitCode.GATE_FAILED;
    return;
  }

  // Summary (averaged over the files that were actually linted)
  const avgScore = evaluated > 0 ? Math.round(totalScore / evaluated) : 0;
  const summaryColor = avgScore >= 80 ? chalk.green : avgScore >= 60 ? chalk.yellow : chalk.red;

  console.log(chalk.bold('─'.repeat(60)));
  console.log(`  ${chalk.bold('Average Score:')} ${summaryColor(`${avgScore}/100`)} (threshold: ${threshold})`);
  console.log(`  ${chalk.bold('Status:')} ${allPassed ? chalk.green.bold('PASSED ✓') : chalk.red.bold('FAILED ✖')}`);
  console.log('');

  if (!allPassed) {
    process.exitCode = ExitCode.GATE_FAILED;
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
