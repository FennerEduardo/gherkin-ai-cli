/* ==========================================================================
   gherkin-ai-cli - 'quality' Command Handler
   ghk quality [--json]: delivery risk + test coverage gate. Exit 4 when a human must approve the deployment.
   ========================================================================== */

import { ExitCode } from '../core/errors';
import chalk from 'chalk';
import { assessDeliveryRisk } from '../core/risk-engine';
import { loadConfig } from '../core/config';
import { runCoverage } from '../core/coverage-integration';
import { emitJson } from '../utils/output';

export interface QualityOptions {
  json?: boolean;
  /** Pass the gate without a coverage figure (unsupported stack, no report). Failing tests still fail it. */
  allowMissingCoverage?: boolean;
  /** Git ref the change is measured against (e.g. origin/main). */
  base?: string;
}

export async function handleQualityCommand(options: QualityOptions = {}): Promise<void> {
  const config = loadConfig();
  const coverageResult = runCoverage(process.cwd(), config);
  // The coverage this run measured is the test evidence for the risk score (not an older report on disk).
  const riskCard = assessDeliveryRisk(process.cwd(), {
    config,
    base: options.base,
    coveragePct: coverageResult.errorMessage ? undefined : coverageResult.coveragePercentage
  });
  // Without a change (no --base, clean tree) the risk describes the whole specification, not a delivery:
  // reported, but not a reason to stop one.
  const riskGates = riskCard.basis !== 'specification';

  // Missing data never counts as a pass: failing tests always fail the gate, a missing coverage figure
  // fails it unless --allow-missing-coverage.
  const testsFailed = (coverageResult.exitCode ?? 0) !== 0;
  const coverageMissing = !testsFailed && Boolean(coverageResult.errorMessage);
  const coverageBelowTarget = !coverageResult.success && !coverageResult.errorMessage;
  const reasons = [
    ...(riskGates && riskCard.requiresHumanApproval ? [`Delivery risk ${riskCard.riskLevel} (score ${riskCard.overallRiskScore}) requires human approval`] : []),
    ...(testsFailed ? [coverageResult.errorMessage as string] : []),
    ...(coverageMissing && !options.allowMissingCoverage ? [`Coverage unavailable: ${coverageResult.errorMessage}`] : []),
    ...(coverageBelowTarget ? [`Code coverage ${coverageResult.coveragePercentage}% is below the target ${coverageResult.targetPercentage}%`] : [])
  ];
  const gatePassed = reasons.length === 0;
  if (!gatePassed) process.exitCode = ExitCode.GATE_FAILED;

  if (options.json) {
    emitJson({
      gatePassed,
      humanApprovalRequired: !gatePassed,
      reasons,
      risk: { ...riskCard, gating: riskGates, ...(riskGates ? {} : { note: 'No change set (pass --base <ref> or have uncommitted changes): the risk describes the whole specification and does not gate.' }) },
      coverage: {
        tool: coverageResult.toolUsed,
        available: !coverageResult.errorMessage,
        percentage: coverageResult.errorMessage ? null : coverageResult.coveragePercentage,
        target: coverageResult.targetPercentage,
        error: coverageResult.errorMessage ?? null,
        command: coverageResult.command ?? null,
        exitCode: coverageResult.exitCode ?? null,
        reportPath: coverageResult.reportPath || null,
        reportMtime: coverageResult.reportMtime ?? null
      }
    });
    return;
  }

  console.log(chalk.bold.cyan('\n📊 Calculating Feature Quality Index Score...\n'));
  console.log('\n======================================================');
  console.log(chalk.bold('  Risk & Quality Evaluation (Risk Engine v3)'));
  console.log('======================================================\n');

  console.log(chalk.cyan('Risk Factors:'));
  console.log(`- Blast Radius:         ${riskCard.blastRadius}/100`);
  console.log(`- Test Strength:        ${riskCard.testStrength}/100`);
  console.log(`- Security Sensitivity: ${riskCard.securitySensitivity}/100`);
  console.log(`- Architecture Drift:   ${riskCard.architectureDrift}/100`);
  console.log('');

  const riskColor = riskCard.riskLevel === 'CRITICAL' || riskCard.riskLevel === 'HIGH' ? chalk.red :
                    riskCard.riskLevel === 'MEDIUM' ? chalk.yellow : chalk.green;

  console.log(chalk.bold(`Risk Level:           ${riskColor(riskCard.riskLevel)} (Score: ${riskCard.overallRiskScore})`));
  if (!riskGates) console.log(chalk.gray('  (no change set: pass --base <ref> to gate on the risk of a change; reported only)'));

  if (riskCard.factors.length > 0) {
    console.log(chalk.yellow('\nKey Risk Drivers:'));
    riskCard.factors.forEach(f => console.log(`  - ${f}`));
  }

  console.log(chalk.cyan('\n🔍 Running Test Coverage Analysis...'));
  console.log(`- Coverage Tool:        ${coverageResult.toolUsed}`);
  if (coverageResult.errorMessage) {
    console.log(chalk.yellow(`- Coverage Report:      ⚠️ Not available (${coverageResult.errorMessage})`));
  } else {
    const covColor = coverageResult.success ? chalk.green : chalk.red;
    console.log(`- Coverage Score:       ${covColor(`${coverageResult.coveragePercentage}%`)} (Target: ${coverageResult.targetPercentage}%)`);
  }

  if (!gatePassed) {
    console.log(chalk.red.bold('\n⚠ HUMAN APPROVAL REQUIRED FOR DEPLOYMENT'));
    reasons.forEach(r => console.log(chalk.red(`  ↳ ${r}`)));
  } else {
    console.log(chalk.green.bold('\n✅ AUTO-DEPLOYMENT SAFE (Quality Gates Passed)'));
  }

  console.log('\n');
}
