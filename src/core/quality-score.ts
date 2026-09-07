/* ==========================================================================
   gherkin-ai-cli - Feature Quality Score Index Engine
   
   Calculates a multi-dimensional Quality Index using Gherkin IR,
   Specification Linter, Context Security Layer, and weighted metrics.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { parseGherkinText } from './gherkin-parser';
import { lintSpecification } from './specification-linter';
import { scanContextSecurity } from './context-security';

export interface FeatureQualityScorecard {
  specificationScore: number;
  unitTestsScore: number;
  integrationTestsScore: number;
  e2eTestsScore: number;
  typeSafetyScore: number;
  securityScore: number;
  overallScore: number;
  passedQualityGate: boolean;
  lintWarningsCount?: number;
  lintErrorsCount?: number;
  securityIssuesCount?: number;
}

export function calculateQualityScorecard(cwd: string = process.cwd(), specDirOverride?: string): FeatureQualityScorecard {
  let specificationScore = 0;
  let lintWarningsCount = 0;
  let lintErrorsCount = 0;

  // 1. Specification Score via SpecificationLinter & IR
  try {
    const { resolveSpecDir } = require('../utils/spec-dir-resolver');
    const specDirPath = resolveSpecDir(specDirOverride, cwd);

    if (fs.existsSync(specDirPath)) {
      const files = fs.readdirSync(specDirPath).filter((f: string) => f.endsWith('.feature'));
      if (files.length > 0) {
        let totalLintScore = 0;
        for (const file of files) {
          const filePath = path.join(specDirPath, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = parseGherkinText(raw);
          const report = lintSpecification(parsed, file);
          totalLintScore += report.score;
          lintWarningsCount += report.diagnostics.filter(d => d.severity === 'warning').length;
          lintErrorsCount += report.diagnostics.filter(d => d.severity === 'error').length;
        }
        specificationScore = Math.round(totalLintScore / files.length);
      } else {
        specificationScore = 20;
      }
    } else {
      specificationScore = 0;
    }
  } catch {
    specificationScore = 0;
  }

  // 2. Unit Tests Score
  let unitTestsScore = 0;
  try {
    const covPath = path.join(cwd, 'coverage', 'coverage-summary.json');
    if (fs.existsSync(covPath)) {
      const data = JSON.parse(fs.readFileSync(covPath, 'utf8'));
      if (data.total && data.total.lines) {
        unitTestsScore = Math.round(data.total.lines.pct || 0);
      }
    } else {
      const testsExist = fs.existsSync(path.join(cwd, 'tests')) || 
                         fs.existsSync(path.join(cwd, 'src', '__tests__')) ||
                         fs.existsSync(path.join(cwd, 'src', 'test'));
      unitTestsScore = testsExist ? 60 : 0;
    }
  } catch {
    unitTestsScore = 0;
  }

  // 3. Integration Tests Score
  const integrationTestsScore = unitTestsScore > 0 ? Math.round(unitTestsScore * 0.75) : 0;

  // 4. E2E Tests Score
  let e2eTestsScore = 0;
  if (fs.existsSync(path.join(cwd, 'cypress')) || 
      fs.existsSync(path.join(cwd, 'playwright')) || 
      fs.existsSync(path.join(cwd, 'e2e'))) {
    e2eTestsScore = 80;
  }

  // 5. Type Safety Score
  let typeSafetyScore = 100;
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    const nodeModulesExists = fs.existsSync(path.join(cwd, 'node_modules'));
    if (!nodeModulesExists) {
      typeSafetyScore = 80;
    }
  } else if (fs.existsSync(path.join(cwd, 'pom.xml')) || fs.existsSync(path.join(cwd, 'build.gradle'))) {
    typeSafetyScore = 95;
  } else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    typeSafetyScore = 100;
  } else {
    typeSafetyScore = 70;
  }

  // 6. Security Score via Context Security Layer
  let securityScore = 100;
  let securityIssuesCount = 0;
  try {
    // Scan sample files in cwd for security
    let aggregatedContent = '';
    const sampleFiles = ['package.json', 'src/index.ts', 'gherkin-ai.config.json'];
    for (const sf of sampleFiles) {
      const p = path.join(cwd, sf);
      if (fs.existsSync(p)) {
        aggregatedContent += fs.readFileSync(p, 'utf8') + '\n';
      }
    }

    const securityScan = scanContextSecurity(aggregatedContent);
    securityIssuesCount = securityScan.findings.length;
    if (securityScan.secretCount > 0) {
      securityScore -= 50;
    } else if (securityScan.findings.length > 0) {
      securityScore -= Math.min(40, securityScan.findings.length * 10);
    }
    
    // Check lockfiles
    const hasLockfile = fs.existsSync(path.join(cwd, 'package-lock.json')) || 
                          fs.existsSync(path.join(cwd, 'yarn.lock')) || 
                          fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ||
                          fs.existsSync(path.join(cwd, 'pom.xml')) ||
                          fs.existsSync(path.join(cwd, 'Cargo.lock'));
    if (!hasLockfile) {
      securityScore -= 15;
    }
  } catch {
    securityScore = 70;
  }

  securityScore = Math.max(0, Math.min(100, securityScore));

  const overallScore = Math.round(
    (specificationScore * 0.25) +
    (unitTestsScore * 0.20) +
    (integrationTestsScore * 0.15) +
    (e2eTestsScore * 0.10) +
    (typeSafetyScore * 0.15) +
    (securityScore * 0.15)
  );

  return {
    specificationScore,
    unitTestsScore,
    integrationTestsScore,
    e2eTestsScore,
    typeSafetyScore,
    securityScore,
    overallScore,
    passedQualityGate: overallScore >= 70 && specificationScore >= 60 && securityScore >= 60,
    lintWarningsCount,
    lintErrorsCount,
    securityIssuesCount,
  };
}
