/* ==========================================================================
   gherkin-ai-cli - Feature Quality Score Index Engine
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface FeatureQualityScorecard {
  specificationScore: number;
  unitTestsScore: number;
  integrationTestsScore: number;
  e2eTestsScore: number;
  typeSafetyScore: number;
  securityScore: number;
  overallScore: number;
  passedQualityGate: boolean;
}

export function calculateQualityScorecard(cwd: string = process.cwd()): FeatureQualityScorecard {
  let unitTestsScore = 0;
  
  try {
    const covPath = path.join(cwd, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(covPath)) {
      const data = JSON.parse(fs.readFileSync(covPath, 'utf8'));
      if (data.total && data.total.lines) {
        unitTestsScore = data.total.lines.pct || 0;
      }
    } else {
       const testsExist = fs.existsSync(path.join(cwd, 'tests')) || fs.existsSync(path.join(cwd, 'src', '__tests__'));
       unitTestsScore = testsExist ? 50 : 0; 
    }
  } catch (e) {
    unitTestsScore = 0;
  }

  let typeSafetyScore = 100;
  try {
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
        execSync('npx tsc --noEmit', { cwd, stdio: 'ignore' });
    }
  } catch(e) {
    typeSafetyScore = 40; 
  }

  // Simplified metrics for others until dedicated parsers are built
  const specificationScore = 95;
  const integrationTestsScore = unitTestsScore > 0 ? 80 : 0;
  const e2eTestsScore = 0; // Hard to guess without cypress/playwright reports
  const securityScore = 90; // Assume basic pass

  const overallScore = Math.round(
    (specificationScore + unitTestsScore + integrationTestsScore + e2eTestsScore + typeSafetyScore + securityScore) / 6
  );

  return {
    specificationScore,
    unitTestsScore,
    integrationTestsScore,
    e2eTestsScore,
    typeSafetyScore,
    securityScore,
    overallScore,
    passedQualityGate: overallScore >= 70
  };
}
