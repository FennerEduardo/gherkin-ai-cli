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

export interface RiskCommandOptions {
  base?: string;
  files?: string;
  failOn?: string;
  json?: boolean;
}

const LABELS: Record<string, string> = {
  security: 'Security',
  businessCriticality: 'Business criticality',
  changeRadius: 'Change radius',
  testWeakness: 'Test weakness',
  contractDrift: 'Contract drift',
  architectureDrift: 'Architecture drift'
};

export async function handleRiskCommand(options: RiskCommandOptions = {}): Promise<void> {
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
