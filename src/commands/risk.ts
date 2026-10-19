/* ==========================================================================
   gherkin-ai-cli - 'risk' command: delivery risk of a change

   ghk risk [--base origin/main] [--files a,b] [--fail-on HIGH] [--json]
   Exits 4 (gate failed) when the risk reaches --fail-on.
   ========================================================================== */

import chalk from 'chalk';
import { loadConfig } from '../core/config';
import { ExitCode, UsageError } from '../core/errors';
import { assessDeliveryRisk, atLeast, RISK_LEVELS, RiskLevel } from '../core/risk-engine';
import { emitJson } from '../utils/output';
import { calibrateRiskWeights } from '../core/risk-calibration';
import fs from 'fs';
import path from 'path';

export interface RiskCommandOptions {
  base?: string;
  files?: string;
  failOn?: string;
  json?: boolean;
  /** Propose policy.risk.weights from the git history. */
  calibrate?: boolean;
  /** Commits of history to calibrate on (default 300). */
  commits?: string;
  /** With --calibrate: save the weights to gherkin-ai.config.json. */
  write?: boolean;
}

const LABELS: Record<string, string> = {
  security: 'Security',
  businessCriticality: 'Business criticality',
  changeRadius: 'Change radius',
  testWeakness: 'Test weakness',
  contractDrift: 'Contract drift',
  architectureDrift: 'Architecture drift'
};

/** ghk risk --calibrate: proposes policy.risk.weights from the git history; --write saves them. */
async function handleCalibrate(options: RiskCommandOptions): Promise<void> {
  const config = loadConfig();
  const limit = options.commits ? parseInt(options.commits, 10) : 300;
  if (!Number.isFinite(limit) || limit < 10) throw new UsageError(`Invalid --commits "${options.commits}".`, { hint: 'Use 10 or more commits.' });
  let calibration;
  try {
    calibration = calibrateRiskWeights(process.cwd(), config, limit);
  } catch (err) {
    throw new UsageError((err as Error).message, { hint: 'Run it in the repository of the service, with its history (git fetch --unshallow in CI).' });
  }
  if (options.write) {
    const file = path.join(process.cwd(), 'gherkin-ai.config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.policy = { ...raw.policy, risk: { ...raw.policy?.risk, weights: calibration.weights } };
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  }
  if (options.json) {
    emitJson({ ...calibration, written: Boolean(options.write) });
    return;
  }
  console.log(chalk.bold(`\nRisk weights from ${calibration.commits} commit(s), ${calibration.riskyCommits} followed by a fix (evidence ${Math.round(calibration.evidence * 100)}%)\n`));
  console.log(`  ${'Dimension'.padEnd(22)} ${'risky'.padStart(6)} ${'other'.padStart(6)} ${'default'.padStart(8)} ${'proposed'.padStart(9)}`);
  for (const d of calibration.dimensions) {
    console.log(`  ${LABELS[d.id].padEnd(22)} ${String(d.meanRisky).padStart(6)} ${String(d.meanOther).padStart(6)} ${d.defaultWeight.toFixed(3).padStart(8)} ${d.weight.toFixed(3).padStart(9)}`);
  }
  console.log(chalk.gray('\n  "risky" and "other": mean dimension score of commits a later fix touched, and of the rest.'));
  console.log(options.write ? chalk.green('\n✔ Saved to policy.risk.weights in gherkin-ai.config.json.\n') : chalk.gray('\n  Run with --write to save them to policy.risk.weights.\n'));
}

export async function handleRiskCommand(options: RiskCommandOptions = {}): Promise<void> {
  if (options.calibrate) return handleCalibrate(options);
  const failOn = options.failOn?.toUpperCase() as RiskLevel | undefined;
  if (failOn && !RISK_LEVELS.includes(failOn)) throw new UsageError(`Invalid --fail-on "${options.failOn}".`, { hint: `Use one of: ${RISK_LEVELS.join(', ')}.` });

  const config = loadConfig();
  let card;
  try {
    card = assessDeliveryRisk(process.cwd(), {
      config,
      base: options.base,
      changedFiles: options.files?.split(',').map(f => f.trim()).filter(Boolean)
    });
  } catch (err) {
    throw new UsageError((err as Error).message, { hint: 'Fetch the base ref first (git fetch origin main) or pass --files.' });
  }
  const failed = failOn ? atLeast(card.riskLevel, failOn) : false;

  if (options.json) {
    emitJson({ ...card, failOn: failOn ?? null, gateFailed: failed });
  } else {
    const color = card.riskLevel === 'CRITICAL' || card.riskLevel === 'HIGH' ? chalk.red : card.riskLevel === 'MEDIUM' ? chalk.yellow : chalk.green;
    const basis = card.basis === 'specification' ? 'whole specification (no change set found)' : `${card.changedFiles.length} changed file(s) (${card.basis})`;
    console.log(chalk.bold(`\nDelivery risk: ${color(card.riskLevel)} (score ${card.overallRiskScore}/100) — ${basis}\n`));
    for (const d of card.dimensions) {
      console.log(`  ${LABELS[d.id].padEnd(22)} ${String(d.score).padStart(3)}/100  (weight ${Math.round(d.weight * 100)}%)`);
      for (const e of d.evidence) console.log(chalk.gray(`      ${e}`));
    }
    console.log('');
    if (card.requiresHumanApproval) console.log(chalk.yellow(`Human approval required (policy.risk.requireApprovalAt = ${card.approvalThreshold}).`));
    if (failed) console.log(chalk.red(`Risk ${card.riskLevel} reaches --fail-on ${failOn}.`));
  }
  if (failed) process.exitCode = ExitCode.GATE_FAILED;
}
