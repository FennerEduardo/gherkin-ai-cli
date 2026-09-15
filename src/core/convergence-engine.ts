/* ==========================================================================
   gherkin-ai-cli - Convergence Engine
   
   Measures alignment between Specification and Implementation.
   The core metric: "Is the code faithful to the spec?"
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { ParsedFeature } from './gherkin-parser';
import { SpecificationIR, EnrichedScenario, ScenarioCategory } from './semantic-ir';
import { buildIR } from './ir-builder';
import { lintSpecification } from './specification-linter';
import { loadConstitution } from './constitution';
import { loadConfig } from './config';

// ---------------------------------------------------------------------------
// Convergence Metrics
// ---------------------------------------------------------------------------

export interface ConvergenceDimension {
  name: string;
  score: number;           // 0-100
  maxScore: number;        // Always 100
  details: string[];
  status: 'pass' | 'warn' | 'fail';
}

export interface ConvergenceReport {
  featureName: string;
  sourceFile: string;
  timestamp: string;
  
  dimensions: ConvergenceDimension[];
  overallConvergence: number;   // 0-100
  status: 'CONVERGED' | 'PARTIAL' | 'DIVERGED';

  // Actionable recommendations
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Convergence Engine
// ---------------------------------------------------------------------------

export function calculateConvergence(
  parsed: ParsedFeature,
  sourceFile: string,
  projectDir: string = process.cwd()
): ConvergenceReport {
  const ir = buildIR(parsed, sourceFile);
  return checkConvergence(ir, projectDir);
}

export function checkConvergence(
  ir: SpecificationIR,
  projectDir: string = process.cwd()
): ConvergenceReport {
  const constitution = loadConstitution(projectDir);
  const dimensions: ConvergenceDimension[] = [];
  const recommendations: string[] = [];

  // 1. Specification Quality
  const specQuality = evaluateSpecificationQuality(ir, ir.qualityIndicators.scenarioCompleteness);
  dimensions.push(specQuality);
  if (specQuality.score < 80) {
    recommendations.push(`Specification quality is ${specQuality.score}%. Run \`ghk lint\` to see detailed issues.`);
  }

  // 2. Scenario Completeness
  const scenarioCompleteness = evaluateScenarioCompleteness(ir);
  dimensions.push(scenarioCompleteness);
  if (scenarioCompleteness.score < 100) {
    recommendations.push(
      `Missing scenario categories: ${ir.qualityIndicators.missingScenarioCategories.join(', ')}. ` +
      `Add scenarios for these paths.`
    );
  }

  // 3. Contract Coverage
  const contractCoverage = evaluateContractCoverage(ir, projectDir);
  dimensions.push(contractCoverage);

  // 4. Architecture Compliance
  const archCompliance = evaluateArchitectureCompliance(ir, constitution, projectDir);
  dimensions.push(archCompliance);

  // 5. Security Policy
  const securityPolicy = evaluateSecurityPolicy(ir, constitution);
  dimensions.push(securityPolicy);
  if (securityPolicy.score < 80) {
    recommendations.push('Security policy gaps detected. Review authorization and data protection scenarios.');
  }

  // 6. Traceability
  const traceability = evaluateTraceability(ir);
  dimensions.push(traceability);

  // 7. Code Coverage (reads real coverage reports from test tools)
  const codeCoverage = evaluateCodeCoverage(projectDir);
  dimensions.push(codeCoverage);
  if (codeCoverage.score < 80 && codeCoverage.score > 0) {
    recommendations.push(`Code coverage is at ${codeCoverage.score}%. Run your test suite with \`--coverage\` to improve.`);
  }

  // Calculate overall convergence
  const overallConvergence = Math.round(
    dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length
  );

  const status: ConvergenceReport['status'] =
    overallConvergence >= 90 ? 'CONVERGED' :
    overallConvergence >= 60 ? 'PARTIAL' :
    'DIVERGED';

  if (ir.qualityIndicators.contradictions.length > 0) {
    recommendations.push(
      `⚠ ${ir.qualityIndicators.contradictions.length} contradiction(s) detected in specifications.`
    );
  }
  if (ir.qualityIndicators.ambiguities.length > 0) {
    recommendations.push(
      `ℹ ${ir.qualityIndicators.ambiguities.length} ambiguity(ies) found. Consider clarifying.`
    );
  }

  return {
    featureName: ir.featureName,
    sourceFile: ir.sourceFile,
    timestamp: new Date().toISOString(),
    dimensions,
    overallConvergence,
    status,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Dimension Evaluators
// ---------------------------------------------------------------------------

function evaluateSpecificationQuality(
  ir: SpecificationIR,
  lintScore: number
): ConvergenceDimension {
  const details: string[] = [];

  if (ir.scenarios.length === 0) {
    details.push('No scenarios defined.');
  } else {
    details.push(`${ir.scenarios.length} scenario(s) defined.`);
  }
  
  if (ir.commands.length > 0) {
    details.push(`${ir.commands.length} command(s) identified.`);
  }
  if (ir.events.length > 0) {
    details.push(`${ir.events.length} domain event(s) detected.`);
  }
  if (ir.fields.length > 0) {
    details.push(`${ir.fields.length} field(s) extracted.`);
  }

  details.push(`Quality indicator score: ${lintScore}/100`);

  return {
    name: 'Specification Quality',
    score: lintScore,
    maxScore: 100,
    details,
    status: lintScore >= 80 ? 'pass' : lintScore >= 60 ? 'warn' : 'fail',
  };
}

function evaluateScenarioCompleteness(ir: SpecificationIR): ConvergenceDimension {
  const details: string[] = [];

  const covered = new Set(ir.scenarios.map(s => s.category));
  const essential: ScenarioCategory[] = ['happy-path', 'validation', 'authorization', 'error-handling'];
  const missingEssential = essential.filter(c => !covered.has(c));

  const score = ir.qualityIndicators.scenarioCompleteness;

  details.push(`Covered categories: ${Array.from(covered).join(', ') || 'none'}`);
  if (missingEssential.length > 0) {
    details.push(`Missing essential: ${missingEssential.join(', ')}`);
  }

  const advanced: ScenarioCategory[] = ['idempotency', 'concurrency', 'timeout', 'partial-failure'];
  const missingAdvanced = advanced.filter(c => !covered.has(c));
  if (missingAdvanced.length > 0) {
    details.push(`Missing advanced: ${missingAdvanced.join(', ')}`);
  }

  return {
    name: 'Scenario Completeness',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

function evaluateContractCoverage(
  ir: SpecificationIR,
  projectDir: string
): ConvergenceDimension {
  const details: string[] = [];
  let score = 0;

  const contractsPath = path.join(projectDir, 'generated-specs', 'contracts.ts');
  const openApiPath = path.join(projectDir, 'generated-specs', 'openapi.json');

  if (fs.existsSync(contractsPath)) {
    score += 40;
    details.push('TypeScript contracts file found.');
    
    const contractContent = fs.readFileSync(contractsPath, 'utf8');
    const featureNameNormalized = ir.featureName.replace(/[^a-zA-Z]/g, '');
    if (contractContent.includes(featureNameNormalized)) {
      score += 20;
      details.push('Contracts match current feature specification.');
    } else {
      details.push('Contracts may be stale — feature name not found in contracts file.');
    }
  } else {
    details.push('No contracts file found. Run `ghk generate` to create contracts.');
  }

  if (fs.existsSync(openApiPath)) {
    score += 20;
    details.push('OpenAPI specification found.');
  } else {
    details.push('No OpenAPI spec found.');
  }

  if (ir.apiEndpoints.length > 0) {
    score += 20;
    details.push(`${ir.apiEndpoints.length} API endpoint(s) inferred from specification.`);
  }

  score = Math.min(100, score);

  return {
    name: 'Contract Coverage',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

function evaluateArchitectureCompliance(
  ir: SpecificationIR,
  constitution: ReturnType<typeof loadConstitution>,
  projectDir: string
): ConvergenceDimension {
  const details: string[] = [];
  let score = 100;

  if (!constitution) {
    details.push('No constitution found. Architecture compliance cannot be fully evaluated.');
    return {
      name: 'Architecture Compliance',
      score: 50,
      maxScore: 100,
      details,
      status: 'warn',
    };
  }

  details.push(`Architecture style: ${constitution.architecture.style}`);

  const mustConstraints = ir.constraints.filter(c => c.level === 'must');
  const mustNotConstraints = ir.constraints.filter(c => c.level === 'must-not');

  if (mustConstraints.length > 0) {
    details.push(`${mustConstraints.length} "must" constraint(s) defined.`);
  }
  if (mustNotConstraints.length > 0) {
    details.push(`${mustNotConstraints.length} "must-not" constraint(s) defined.`);
  }

  if (constitution.architecture.layers) {
    for (const layer of constitution.architecture.layers) {
      const layerPath = path.join(projectDir, 'src', layer);
      if (fs.existsSync(layerPath)) {
        details.push(`Layer "${layer}" directory exists.`);
      } else {
        score -= 10;
        details.push(`Layer "${layer}" directory missing.`);
      }
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: 'Architecture Compliance',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

function evaluateSecurityPolicy(
  ir: SpecificationIR,
  constitution: ReturnType<typeof loadConstitution>
): ConvergenceDimension {
  const details: string[] = [];
  let score = 100;

  const securityRisks = ir.risks.filter(r => r.category === 'security');
  if (securityRisks.length > 0) {
    score -= securityRisks.length * 15;
    for (const risk of securityRisks) {
      details.push(`Risk: ${risk.description}`);
    }
  }

  const authAssumptions = ir.assumptions.filter(a =>
    a.description.toLowerCase().includes('auth') || a.description.toLowerCase().includes('access')
  );
  if (authAssumptions.length > 0) {
    score -= authAssumptions.length * 10;
    for (const a of authAssumptions) {
      details.push(`Assumption: ${a.description}`);
    }
  }

  const secPolicies = ir.policies.filter(p => p.type === 'security' || p.type === 'authorization');
  if (secPolicies.length > 0) {
    details.push(`${secPolicies.length} security/auth policy(ies) defined.`);
  } else {
    score -= 10;
    details.push('No security policies inferred from specification.');
  }

  if (constitution?.security?.dataClassification) {
    details.push(`Data classification: ${constitution.security.dataClassification}`);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: 'Security Policy',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

function evaluateTraceability(ir: SpecificationIR): ConvergenceDimension {
  const details: string[] = [];

  const score = ir.traceability.coverage.coveragePercent;

  details.push(`Traceability links: ${ir.traceability.links.length}`);
  details.push(`Specified requirements: ${ir.traceability.coverage.specifiedRequirements}`);
  details.push(`Tested requirements: ${ir.traceability.coverage.testedRequirements}`);
  details.push(`Coverage: ${score}%`);

  return {
    name: 'Traceability',
    score: Math.min(100, score),
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

// ---------------------------------------------------------------------------
// Code Coverage Dimension (Integration with Istanbul/c8/Vitest/JaCoCo)
// ---------------------------------------------------------------------------

interface CoverageSummaryEntry {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummaryReport {
  total: {
    lines: CoverageSummaryEntry;
    statements: CoverageSummaryEntry;
    functions: CoverageSummaryEntry;
    branches: CoverageSummaryEntry;
  };
}

function evaluateCodeCoverage(projectDir: string): ConvergenceDimension {
  const details: string[] = [];
  const config = loadConfig();
  const target = config.rules?.coverageTarget || 85;

  // Search for coverage report in common locations
  const candidatePaths = [
    path.join(projectDir, 'coverage', 'coverage-summary.json'),  // Istanbul/c8/vitest default
    path.join(projectDir, 'coverage', 'coverage-final.json'),
    path.join(projectDir, '.nyc_output', 'coverage-summary.json'),
  ];

  let summaryPath: string | null = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      summaryPath = p;
      break;
    }
  }

  if (!summaryPath) {
    details.push('No coverage report found.');
    details.push(`→ Run your test suite with --coverage (e.g., \`vitest run --coverage\`, \`npx jest --coverage\`)`);
    details.push(`→ Expected location: coverage/coverage-summary.json`);
    return {
      name: 'Code Coverage',
      score: 0,
      maxScore: 100,
      details,
      status: 'fail',
    };
  }

  try {
    const raw = fs.readFileSync(summaryPath, 'utf8');
    const report: CoverageSummaryReport = JSON.parse(raw);
    const total = report.total;

    if (!total || !total.lines) {
      details.push('Coverage report found but format is not recognized.');
      return {
        name: 'Code Coverage',
        score: 0,
        maxScore: 100,
        details,
        status: 'fail',
      };
    }

    const linesPct = Math.round(total.lines.pct);
    const branchesPct = Math.round(total.branches?.pct || 0);
    const functionsPct = Math.round(total.functions?.pct || 0);
    const statementsPct = Math.round(total.statements?.pct || 0);

    // Weighted average: lines 40%, branches 30%, functions 20%, statements 10%
    const weightedScore = Math.round(
      linesPct * 0.4 + branchesPct * 0.3 + functionsPct * 0.2 + statementsPct * 0.1
    );

    details.push(`Lines: ${linesPct}% | Branches: ${branchesPct}% | Functions: ${functionsPct}% | Statements: ${statementsPct}%`);
    details.push(`Weighted score: ${weightedScore}% (target: ${target}%)`);
    details.push(`Source: ${path.relative(projectDir, summaryPath)}`);

    if (weightedScore < target) {
      details.push(`⚠ Below coverage target of ${target}%`);
    }

    return {
      name: 'Code Coverage',
      score: Math.min(100, weightedScore),
      maxScore: 100,
      details,
      status: weightedScore >= target ? 'pass' : weightedScore >= (target * 0.7) ? 'warn' : 'fail',
    };
  } catch (err: any) {
    details.push(`Failed to parse coverage report: ${err.message}`);
    return {
      name: 'Code Coverage',
      score: 0,
      maxScore: 100,
      details,
      status: 'fail',
    };
  }
}
