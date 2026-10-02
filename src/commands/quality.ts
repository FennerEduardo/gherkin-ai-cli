/* ==========================================================================
   gherkin-ai-cli - 'quality' Command Handler
   ========================================================================== */

import { ExitCode } from '../core/errors';
import chalk from 'chalk';
import { calculateDeliveryRisk } from '../core/risk-engine';
import { loadConfig } from '../core/config';
import { runCoverage } from '../core/coverage-integration';

export async function handleQualityCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n📊 Calculating Feature Quality Index Score...\n'));

  const config = loadConfig();
  const riskCard = calculateDeliveryRisk(process.cwd(), config.specDir);

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
  
  if (riskCard.factors.length > 0) {
    console.log(chalk.yellow('\nKey Risk Drivers:'));
    riskCard.factors.forEach(f => console.log(`  - ${f}`));
  }

  console.log(chalk.cyan('\n🔍 Running Test Coverage Analysis...'));
  const coverageResult = runCoverage(process.cwd(), config);

  console.log(`- Coverage Tool:        ${coverageResult.toolUsed}`);
  if (coverageResult.errorMessage) {
    console.log(chalk.yellow(`- Coverage Report:      ⚠️ Not available (${coverageResult.errorMessage})`));
  } else {
    const covColor = coverageResult.success ? chalk.green : chalk.red;
    console.log(`- Coverage Score:       ${covColor(`${coverageResult.coveragePercentage}%`)} (Target: ${coverageResult.targetPercentage}%)`);
  }

  if (riskCard.requiresHumanApproval || (!coverageResult.success && !coverageResult.errorMessage)) {
    console.log(chalk.red.bold('\n⚠ HUMAN APPROVAL REQUIRED FOR DEPLOYMENT'));
    if (!coverageResult.success && !coverageResult.errorMessage) {
      console.log(chalk.red(`  ↳ Code Coverage (${coverageResult.coveragePercentage}%) is below the required target (${coverageResult.targetPercentage}%)`));
    }
    process.exitCode = ExitCode.GATE_FAILED;
  } else {
    console.log(chalk.green.bold('\n✅ AUTO-DEPLOYMENT SAFE (Quality Gates Passed)'));
  }
  
  console.log('\n');
}
