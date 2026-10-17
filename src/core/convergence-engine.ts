/* ==========================================================================
   gherkin-ai-cli - Convergence Engine
   
   Measures alignment between Specification and Implementation.
   The core metric: "Is the code faithful to the spec?"
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { ParsedFeature } from './gherkin-parser';
import { SpecificationIR, EnrichedScenario, ScenarioCategory } from './semantic-ir';
import { buildIR, getSourceFeature, coveredCategories } from './ir-builder';
import { buildDomainModel } from '../generators/kernel/domain-model';
import { lintSpecification, LintRule } from './specification-linter';
import { industryLintOptions } from './profiles/industries';
import { loadConstitution } from './constitution';
import { loadConfig } from './config';
import { COVERAGE_REPORT_PATHS, findCoverage } from './coverage-reports';
import { findLayerDirs } from './arch-rules';
import { CONTRACTS_DIR, featureContractSlug } from './contracts/merge';

// ---------------------------------------------------------------------------
// Convergence Metrics
// ---------------------------------------------------------------------------

export interface ConvergenceDimension {
  name: string;
  score: number;           // 0-100
  maxScore: number;        // Always 100
  details: string[];
  status: 'pass' | 'warn' | 'fail';
  /** What the score is computed from: the generated/implemented artifacts, the specification alone, or test reports. */
  basis?: 'artifacts' | 'specification' | 'reports';
  /** false when there is nothing to measure (e.g. no coverage report); excluded from the overall score. */
  applicable?: boolean;
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

export interface ConvergenceOptions {
  /** Directory of the generated artifacts (config.outputDir). Defaults to the project config value. */
  outputDir?: string;
}

function configuredOutputDir(projectDir: string): string {
  try {
    return loadConfig(path.join(projectDir, 'gherkin-ai.config.json')).outputDir || './';
  } catch {
    return './generated-specs';
  }
}

/** Same industry rules as `ghk lint`, so the specification dimension matches its score. */
function configuredIndustryLint(projectDir: string): { rules: LintRule[]; disabledRules: string[] } {
  try {
    return industryLintOptions(loadConfig(path.join(projectDir, 'gherkin-ai.config.json')));
  } catch {
    return { rules: [], disabledRules: [] };
  }
}

export function calculateConvergence(
  parsed: ParsedFeature,
  sourceFile: string,
  projectDir: string = process.cwd(),
  options: ConvergenceOptions = {}
): ConvergenceReport {
  const ir = buildIR(parsed, sourceFile);
  return checkConvergence(ir, projectDir, options);
}

export function checkConvergence(
  ir: SpecificationIR,
  projectDir: string = process.cwd(),
  options: ConvergenceOptions = {}
): ConvergenceReport {
  const outputDir = options.outputDir ?? configuredOutputDir(projectDir);
  const constitution = loadConstitution(projectDir);
  const dimensions: ConvergenceDimension[] = [];
  const recommendations: string[] = [];

  // 1. Specification Quality
  // The lint score of the source feature; the IR-derived completeness is only a fallback.
  const sourceFeature = getSourceFeature(ir);
  const lintScore = sourceFeature ? lintSpecification(sourceFeature, ir.sourceFile, configuredIndustryLint(projectDir)).score : ir.qualityIndicators.scenarioCompleteness;
  const specQuality = evaluateSpecificationQuality(ir, lintScore, !!sourceFeature);
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
  const contractCoverage = evaluateContractCoverage(ir, projectDir, outputDir);
  dimensions.push(contractCoverage);

  // 4. Architecture Compliance
  const archCompliance = evaluateArchitectureCompliance(ir, constitution, projectDir, outputDir);
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
  const codeCoverage = evaluateCodeCoverage(projectDir, outputDir);
  dimensions.push(codeCoverage);
  if (codeCoverage.score < 80 && codeCoverage.score > 0) {
    recommendations.push(`Code coverage is at ${codeCoverage.score}%. Run your test suite with \`--coverage\` to improve.`);
  }

  // Calculate overall convergence
  const measured = dimensions.filter(d => d.applicable !== false);
  const overallConvergence = Math.round(measured.reduce((sum, d) => sum + d.score, 0) / Math.max(1, measured.length));

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
  lintScore: number,
  fromLint = true
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

  details.push(fromLint ? `Lint score: ${lintScore}/100` : `Quality indicator score: ${lintScore}/100`);

  return {
    name: 'Specification Quality',
    basis: 'specification',
    score: lintScore,
    maxScore: 100,
    details,
    status: lintScore >= 80 ? 'pass' : lintScore >= 60 ? 'warn' : 'fail',
  };
}

function evaluateScenarioCompleteness(ir: SpecificationIR): ConvergenceDimension {
  const details: string[] = [];

  const covered = coveredCategories(ir.scenarios);
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
    basis: 'specification',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
  };
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|cs|java|kt|py|go|php|rb|ex|exs|rs|dart|proto|graphql)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'target', '_build', 'deps', 'vendor', '.dart_tool', 'coverage']);

function readSources(dir: string, limit = 3000): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
      else if (SOURCE_EXTENSIONS.test(e.name)) { try { out.push(fs.readFileSync(full, 'utf8')); } catch { /* unreadable */ } }
    }
  };
  walk(dir);
  return out;
}

/** "/orders/:id" and "/orders/{orderId}" compare equal. */
const normalizeRoute = (p: string) => p.replace(/:\w+/g, '{}').replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '').toLowerCase();

const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };

/**
 * Contract coverage, checked against the artifacts (not against file names):
 * - every endpoint the spec implies exists in openapi.json with its method and status codes;
 * - every domain event has an AsyncAPI channel/message;
 * - the aggregate, every command and every event of the domain model is declared in the sources.
 * Checks that do not apply (e.g. no endpoints in the spec) are left out of the score.
 */
function evaluateContractCoverage(
  ir: SpecificationIR,
  projectDir: string,
  outputDir: string
): ConvergenceDimension {
  const details: string[] = [];
  const parts: { name: string; found: number; total: number }[] = [];
  const outAbs = path.resolve(projectDir, outputDir);
  // The feature's own contracts (contracts/<feature>/), else the service-wide merged ones.
  const featureDir = path.join(outAbs, CONTRACTS_DIR, featureContractSlug(ir.sourceFile, ir.featureName));
  const contractFile = (name: string) => (fs.existsSync(path.join(featureDir, name)) ? path.join(featureDir, name) : path.join(outAbs, name));

  // 1. OpenAPI: method + path (+ response codes) per inferred endpoint.
  if (ir.apiEndpoints.length) {
    const openapi = readJson(contractFile('openapi.json'));
    const paths: Record<string, Record<string, any>> = openapi?.paths ?? {};
    const byRoute = new Map(Object.entries(paths).map(([route, ops]) => [normalizeRoute(route), ops]));
    let found = 0;
    for (const ep of ir.apiEndpoints) {
      const op = byRoute.get(normalizeRoute(ep.path))?.[ep.method.toLowerCase()];
      const missingCodes = op ? ep.httpCodes.map(c => String(c.code)).filter(code => !(code in (op.responses ?? {}))) : [];
      if (op && missingCodes.length === 0) found++;
      else details.push(op ? `OpenAPI ${ep.method} ${ep.path} lacks responses ${missingCodes.join(', ')}.` : `OpenAPI has no ${ep.method} ${ep.path}.`);
    }
    if (!openapi) details.push(`No openapi.json in ${outputDir}. Run \`ghk generate\`.`);
    parts.push({ name: 'OpenAPI operations', found, total: ir.apiEndpoints.length });
  }

  // 2. AsyncAPI: one message/channel per domain event.
  if (ir.events.length) {
    const asyncapiText = (() => { try { return fs.readFileSync(contractFile('asyncapi.json'), 'utf8'); } catch { return ''; } })();
    const missing = ir.events.map(e => String(e.name)).filter(name => !asyncapiText.includes(name.replace(/[^A-Za-z0-9]/g, '')));
    parts.push({ name: 'AsyncAPI events', found: ir.events.length - missing.length, total: ir.events.length });
    if (missing.length) details.push(`AsyncAPI is missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}.`);
  }

  // 3. Domain model types declared in the generated / implemented sources.
  const source = getSourceFeature(ir);
  if (source) {
    const model = buildDomainModel(source);
    const expected = [`${model.pascal}Aggregate`, ...model.commands.map(c => c.name), ...model.commands.map(c => c.event)];
    const corpus = readSources(outAbs).join('\n');
    const missing = [...new Set(expected)].filter(name => !new RegExp(`\\b${name}\\b`).test(corpus));
    parts.push({ name: 'Domain types', found: new Set(expected).size - missing.length, total: new Set(expected).size });
    if (missing.length) details.push(`Not found in ${outputDir}: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}.`);
  }

  for (const p of parts) details.unshift(`${p.name}: ${p.found}/${p.total}`);
  const total = parts.reduce((s, p) => s + p.total, 0);
  const score = total ? Math.round((parts.reduce((s, p) => s + p.found, 0) / total) * 100) : 0;
  if (!total) details.push('Nothing to check: the specification implies no endpoints, events or commands.');

  return {
    name: 'Contract Coverage',
    score,
    maxScore: 100,
    details,
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
    basis: 'artifacts'
  };
}

function evaluateArchitectureCompliance(
  ir: SpecificationIR,
  constitution: ReturnType<typeof loadConstitution>,
  projectDir: string,
  outputDir = './'
): ConvergenceDimension {
  const details: string[] = [];
  let score = 100;

  if (!constitution) {
    details.push('No constitution found. Architecture compliance cannot be fully evaluated.');
    return {
      name: 'Architecture Compliance',
      basis: 'artifacts',
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
      // Layers live at any depth: src/<layer>, src/main/java/**/<layer>, internal/<layer>, X.<Layer> projects.
      const dirs = findLayerDirs([projectDir, path.resolve(projectDir, outputDir)], layer);
      if (dirs.length) {
        details.push(`Layer "${layer}": ${dirs.slice(0, 3).join(', ')}${dirs.length > 3 ? ', ...' : ''}`);
      } else {
        score -= 10;
        details.push(`Layer "${layer}" directory missing.`);
      }
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: 'Architecture Compliance',
    basis: 'artifacts',
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
    basis: 'specification',
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
    basis: 'specification',
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

function evaluateCodeCoverage(projectDir: string, outputDir = './'): ConvergenceDimension {
  let target = 85;
  try {
    target = loadConfig(path.join(projectDir, 'gherkin-ai.config.json')).rules?.coverageTarget || 85;
  } catch {
    // keep the default target
  }
  const found = findCoverage([projectDir, path.resolve(projectDir, outputDir)]);
  if (!found) {
    // No report: not applicable rather than 0%, so a specs-only or not-yet-tested project is not penalized.
    return {
      name: 'Code Coverage', basis: 'reports', applicable: false,
      score: 0, maxScore: 100, status: 'warn',
      details: [
        'No coverage report found (not counted in the overall score).',
        '→ Produce one with your test runner, e.g. `vitest run --coverage`, `npx jest --coverage`, `mvn verify` (JaCoCo), `dotnet test --collect:"XPlat Code Coverage"`.',
        `→ Looked for: ${COVERAGE_REPORT_PATHS.join(', ')}`
      ]
    };
  }
  const { lines, branches, functions, statements } = found.totals;
  return calculateFinalCoverageScore(lines, branches, functions, statements, target, found.file, projectDir);
}
function calculateFinalCoverageScore(linesPct: number, branchesPct: number, functionsPct: number, statementsPct: number, target: number, summaryPath: string, projectDir: string): ConvergenceDimension {
    // Weighted average: lines 40%, branches 30%, functions 20%, statements 10%
    const weightedScore = Math.round(
      linesPct * 0.4 + branchesPct * 0.3 + functionsPct * 0.2 + statementsPct * 0.1
    );

    const details: string[] = [];
    details.push(`Lines: ${linesPct}% | Branches: ${branchesPct}% | Functions: ${functionsPct}% | Statements: ${statementsPct}%`);
    details.push(`Weighted score: ${weightedScore}% (target: ${target}%)`);
    details.push(`Source: ${path.relative(projectDir, summaryPath)}`);

    if (weightedScore < target) {
      details.push(`⚠ Below coverage target of ${target}%`);
    }

    return {
      name: 'Code Coverage', basis: 'reports',
      score: Math.min(100, weightedScore),
      maxScore: 100,
      details,
      status: weightedScore >= target ? 'pass' : weightedScore >= (target * 0.7) ? 'warn' : 'fail',
    };
}
