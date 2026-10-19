/* ==========================================================================
   gherkin-ai-cli - ghk report: gherkin-ai results on pull / merge requests (4.7)

   ghk report --provider github|gitlab [--base origin/main] [--threshold 70] [--fail-on HIGH] [--out file]

   Runs lint, converge and risk over the project and publishes them where the
   CI platform shows them, with no token or extra permission:
   - github: workflow-command annotations on the .feature lines of the pull
     request, and a Markdown summary in $GITHUB_STEP_SUMMARY;
   - gitlab: a Code Quality report (gl-code-quality-report.json) for the
     merge request widget, and the same summary on stdout.
   Exit 4 when a feature is below the lint threshold or the risk reaches
   --fail-on.
   ========================================================================== */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadConfig, loadResolvedConfig } from '../core/config';
import { loadConstitution } from '../core/constitution';
import { calculateConvergence } from '../core/convergence-engine';
import { ExitCode, UsageError } from '../core/errors';
import { parseGherkinText } from '../core/gherkin-parser';
import { industryLintOptions } from '../core/profiles/industries';
import { assessDeliveryRisk, atLeast, DeliveryRiskScorecard, RISK_LEVELS, RiskLevel } from '../core/risk-engine';
import { LintDiagnostic, lintSpecification } from '../core/specification-linter';
import { projectFeatureFiles } from '../core/workspace-projects';
import { emitJson } from '../utils/output';

export interface ReportOptions {
  provider?: string;
  base?: string;
  threshold?: string;
  failOn?: string;
  out?: string;
  json?: boolean;
}

export interface FeatureReport {
  file: string;
  feature: string;
  lintScore: number;
  passed: boolean;
  convergence: number;
  diagnostics: LintDiagnostic[];
}

/** GitHub workflow-command escaping (data and property values). */
const ghData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s: string) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function githubAnnotations(features: FeatureReport[]): string[] {
  const level = { error: 'error', warning: 'warning', info: 'notice' } as const;
  return features.flatMap(f => f.diagnostics.map(d =>
    `::${level[d.severity]} file=${ghProp(f.file)},line=${d.line ?? 1},title=${ghProp(`${d.ruleId} ${f.feature}`)}::${ghData(d.suggestion ? `${d.message} ${d.suggestion}` : d.message)}`));
}

export function gitlabCodeQuality(features: FeatureReport[]): object[] {
  const severity = { error: 'major', warning: 'minor', info: 'info' } as const;
  return features.flatMap(f => f.diagnostics.map(d => ({
    description: d.suggestion ? `${d.message} ${d.suggestion}` : d.message,
    check_name: d.ruleId,
    fingerprint: crypto.createHash('sha1').update(`${f.file}|${d.ruleId}|${d.message}|${d.line ?? 0}`).digest('hex'),
    severity: severity[d.severity],
    location: { path: f.file, lines: { begin: d.line ?? 1 } }
  })));
}

export function markdownSummary(features: FeatureReport[], risk: DeliveryRiskScorecard | undefined, threshold: number, version: string): string {
  const rows = features.map(f => `| ${f.passed ? '✅' : '❌'} \`${f.file}\` | ${f.lintScore}/100 | ${f.convergence}% | ${f.diagnostics.length} |`);
  return [
    `### gherkin-ai ${version}`,
    '',
    `| Feature | Lint (threshold ${threshold}) | Convergence | Findings |`,
    '|---|---|---|---|',
    ...rows,
    '',
    risk ? `**Delivery risk:** ${risk.riskLevel} (score ${risk.overallRiskScore}/100, ${risk.changedFiles.length} changed file(s))${risk.factors.length ? `\n\n${risk.factors.slice(0, 5).map(f => `- ${f}`).join('\n')}` : ''}` : '**Delivery risk:** not assessed (no change set).',
    ''
  ].join('\n');
}

export async function handleReportCommand(options: ReportOptions = {}): Promise<void> {
  const provider = (options.provider ?? (process.env.GITLAB_CI ? 'gitlab' : 'github')).toLowerCase();
  if (!['github', 'gitlab'].includes(provider)) throw new UsageError(`Unknown --provider "${options.provider}".`, { hint: 'Use github or gitlab.' });
  const failOn = options.failOn?.toUpperCase() as RiskLevel | undefined;
  if (failOn && !RISK_LEVELS.includes(failOn)) throw new UsageError(`Invalid --fail-on "${options.failOn}".`, { hint: `Use one of: ${RISK_LEVELS.join(', ')}.` });
  const threshold = parseInt(options.threshold || '70', 10);
  const cwd = process.cwd();
  const config = loadConfig();
  const lintOptions = { threshold, constitution: loadConstitution(), ...industryLintOptions(loadResolvedConfig({ cwd }).config) };

  const features: FeatureReport[] = projectFeatureFiles(cwd).map(file => {
    const parsed = parseGherkinText(fs.readFileSync(file, 'utf8'));
    const lint = lintSpecification(parsed, file, lintOptions);
    return {
      file: path.relative(cwd, file).split(path.sep).join('/'),
      feature: parsed.featureName,
      lintScore: lint.score,
      passed: lint.passed,
      convergence: calculateConvergence(parsed, file, cwd).overallConvergence,
      diagnostics: lint.diagnostics
    };
  });
  let risk: DeliveryRiskScorecard | undefined;
  try {
    risk = assessDeliveryRisk(cwd, { config, base: options.base });
  } catch {
    risk = undefined; // no git or unknown base: reported as not assessed
  }
  const failed = features.some(f => !f.passed) || Boolean(failOn && risk && atLeast(risk.riskLevel, failOn));
  const { CLI_VERSION } = await import('../version');
  const summary = markdownSummary(features, risk, threshold, CLI_VERSION);

  if (provider === 'github') {
    for (const line of githubAnnotations(features)) process.stdout.write(`${line}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    else if (!options.json) process.stdout.write(`${summary}\n`);
  } else {
    const out = options.out ?? 'gl-code-quality-report.json';
    fs.writeFileSync(out, JSON.stringify(gitlabCodeQuality(features), null, 2) + '\n');
    if (!options.json) process.stdout.write(`${summary}\nCode Quality report: ${out}\n`);
  }
  if (options.json) emitJson({ provider, features: features.map(({ diagnostics, ...f }) => ({ ...f, findings: diagnostics.length })), risk: risk ? { level: risk.riskLevel, score: risk.overallRiskScore } : null, gateFailed: failed });
  if (failed) process.exitCode = ExitCode.GATE_FAILED;
}
