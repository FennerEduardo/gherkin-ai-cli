/* ==========================================================================
   gherkin-ai-cli - 'quality' Command Handler
   ========================================================================== */

import chalk from 'chalk';
import { calculateQualityScorecard } from '../core/quality-score';

export async function handleQualityCommand(): Promise<void> {
  console.log(chalk.bold.cyan('\n📊 Calculating Feature Quality Index Score...\n'));

  const scorecard = calculateQualityScorecard();

  console.log(`  Specification Score : ${chalk.bold.green(scorecard.specificationScore + '%')}`);
  console.log(`  Unit Tests Score    : ${chalk.bold.green(scorecard.unitTestsScore + '%')}`);
  console.log(`  Integration Tests   : ${chalk.bold.green(scorecard.integrationTestsScore + '%')}`);
  console.log(`  E2E Playwright Score: ${chalk.bold.green(scorecard.e2eTestsScore + '%')}`);
  console.log(`  Type Safety Score   : ${chalk.bold.green(scorecard.typeSafetyScore + '%')}`);
  console.log(`  Security Audit Score: ${chalk.bold.green(scorecard.securityScore + '%')}`);
  console.log('  ─────────────────────────────────────');
  console.log(`  ${chalk.bold('Overall Quality Score')}: ${chalk.bold.cyan(scorecard.overallScore + '%')}`);

  if (scorecard.passedQualityGate) {
    console.log(chalk.bold.green('\n🎉 PASS: Feature meets enterprise quality gate threshold (>= 90%).\n'));
  } else {
    console.log(chalk.bold.red('\n✖ FAIL: Feature failed enterprise quality gate threshold.\n'));
    process.exitCode = 1;
  }
}
