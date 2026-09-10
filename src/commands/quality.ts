/* ==========================================================================
   gherkin-ai-cli - 'quality' Command Handler
   ========================================================================== */

import chalk from 'chalk';
import { calculateDeliveryRisk } from '../core/risk-engine';
import { loadConfig } from '../core/config';

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

  if (riskCard.requiresHumanApproval) {
    console.log(chalk.red.bold('\n⚠ HUMAN APPROVAL REQUIRED FOR DEPLOYMENT'));
    process.exitCode = 1;
  } else {
    console.log(chalk.green.bold('\n✅ AUTO-DEPLOYMENT SAFE (Low Risk)'));
  }
  
  console.log('\n');
}
