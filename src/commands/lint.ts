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
import { forEachProjectFeature, formatFeatureTable, requireProjectFeatures, resolveFeatureFile } from '../core/workspace-projects';
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
  /** No feature files is an empty result instead of a usage error. */
  allowEmpty?: boolean;
  /** Ask the configured LLM to propose @aggregate/@command/@event tags (patch proposals; the lint result is unchanged). */
  assist?: boolean;
}

/**
 * `ghk lint --assist`: for each feature whose names the deterministic extraction could not find (GHK016, no
 * tags), the LLM proposes the tags, validated against naming rules and aligned with the code's type names.
 * Proposals go to .ghe/patches/; nothing else is written and the exit code is the LLM's, not the lint's.
 */
async function assistNaming(featureFiles: string[], options: LintCommandOptions): Promise<void> {
  const { buildIR } = await import('../core/ir-builder');
  const { codeTypeNames, proposeIrTags } = await import('../core/ir/assist');
  const { LLMClient, resolveLLMSettings } = await import('../core/llm');
  const { writeProposal } = await import('../core/governance/agent-changes');
  const client = new LLMClient(resolveLLMSettings());
  const codeTypes = codeTypeNames(process.cwd());
  const results = [];
  for (const file of featureFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseGherkinText(text);
    const declared = parsed.tags.some(t => /^@(aggregate|command|event):/.test(t));
    const needsHelp = !declared && lintSpecification(parsed, file).diagnostics.some(d => d.ruleId === 'GHK016');
    if (!needsHelp) {
      results.push({ file: path.relative(process.cwd(), file), status: declared ? 'declared' : 'named' });
      continue;
    }
    const assisted = await proposeIrTags(client, parsed, buildIR(parsed, path.basename(file)), text, codeTypes);
    const changed = assisted.featureText !== text;
    const patch = changed ? path.relative(process.cwd(), writeProposal(process.cwd(), file, assisted.featureText)) : undefined;
    results.push({ file: path.relative(process.cwd(), file), status: changed ? 'proposed' : 'no-valid-names', patch, ...assisted, featureText: undefined });
  }
  if (options.json) return emitJson(results);
  for (const r of results as any[]) {
    if (r.status === 'proposed') {
      console.log(chalk.green(`  ✓ ${r.file}: ${r.patch}`));
      console.log(chalk.gray(`    ${[r.proposal.aggregate && `@aggregate:${r.proposal.aggregate}`, ...r.proposal.commands.map((c: string) => `@command:${c}`), ...r.proposal.events.map((e: string) => `@event:${e}`)].filter(Boolean).join(' ')}`));
      if (r.alignedWithCode.length) console.log(chalk.gray(`    matches code types: ${r.alignedWithCode.join(', ')}`));
    } else if (r.status === 'no-valid-names') console.log(chalk.yellow(`  ⚠ ${r.file}: the model proposed no name that passes the rules`));
    else console.log(chalk.gray(`  · ${r.file}: ${r.status === 'declared' ? 'tags already declared' : 'named by the deterministic extraction'}`));
    for (const x of r.rejected ?? []) console.log(chalk.gray(`    rejected ${x.name}: ${x.reason}`));
  }
  if (results.some((r: any) => r.status === 'proposed')) console.log(chalk.cyan('\n  Review and apply with `git apply <patch>`; then `ghk lint --explain-ir`.\n'));
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

  // A -f that names no feature is linted as a missing file (GHK000, exit 4), as in 3.x.
  const explicit = (feature: string) => { try { return resolveFeatureFile(feature); } catch { return path.resolve(feature); } };
  const featureFiles = options.feature ? [explicit(options.feature)] : requireProjectFeatures(process.cwd(), options.allowEmpty);
  if (featureFiles.length === 0) {
    if (options.json) emitJson([]);
    else console.log(chalk.yellow('\n⚠ No .feature files found to lint (--allow-empty).\n'));
    return;
  }

  if (options.assist) return assistNaming(featureFiles, options);

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
