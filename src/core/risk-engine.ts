/* ==========================================================================
   gherkin-ai-cli - Delivery risk engine

   Answers "how risky is this change?" with LOW / MEDIUM / HIGH / CRITICAL
   instead of pass/fail. The change set is the git diff against a base ref,
   an explicit file list, or the working tree; without any of them the whole
   specification is assessed. Six weighted dimensions, each with evidence:

     security (25%)  business criticality (15%)  change radius (25%)
     test weakness (20%)  contract drift (10%)  architecture drift (5%)

   Deterministic: files, specs, coverage reports and git only — no LLM.
   policy.risk.requireApprovalAt sets the level that needs a human (default HIGH).
   ========================================================================== */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parseGherkinText } from './gherkin-parser';
import { buildSpecificationIR } from './ir-builder';
import { calculateConvergence } from './convergence-engine';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { scanContextSecurity } from './context-security';
import { isTestPath } from './graph/repository-graph';
import { BUILTIN_APPROVAL_PATHS } from './governance/agent-firewall';
import { firstMatch } from '../utils/glob';
import type { GherkinAIConfig } from './config';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const RISK_LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export type RiskDimensionId = 'security' | 'businessCriticality' | 'changeRadius' | 'testWeakness' | 'contractDrift' | 'architectureDrift';

export interface RiskDimension {
  id: RiskDimensionId;
  /** 0-100, higher = riskier. */
  score: number;
  weight: number;
  evidence: string[];
}

export interface DeliveryRiskScorecard {
  /** What was assessed: a git diff, an explicit file list, the working tree, or the whole specification. */
  basis: 'git-diff' | 'files' | 'working-tree' | 'specification';
  changedFiles: string[];
  dimensions: RiskDimension[];
  // Summary values kept for existing consumers (quality, autopilot, MCP).
  blastRadius: number;
  testStrength: number;
  securitySensitivity: number;
  architectureDrift: number;
  overallRiskScore: number;
  riskLevel: RiskLevel;
  approvalThreshold: RiskLevel;
  requiresHumanApproval: boolean;
  factors: string[];
}

export interface RiskOptions {
  specDir?: string;
  /** Explicit change set (project-relative paths). */
  changedFiles?: string[];
  /** Git ref to diff against (e.g. origin/main). */
  base?: string;
  config?: Partial<GherkinAIConfig>;
}

const SECURITY_PATH = /(^|[\/_.-])(auth|security|crypto|permission|rbac|acl|iam|oauth|jwt|token|session|password|secret|tenant)/i;
const CRITICAL_PATH = /(^|[\/_.-])(payment|billing|invoice|ledger|checkout|refund|settlement|wallet|order)s?([\/_.-]|$)/i;
const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|Gemfile(\.lock)?|composer\.(json|lock)|mix\.(exs|lock)|Cargo\.(toml|lock)|pubspec\.yaml|.*\.csproj)$/;
const CONTRACT_FILES = /(openapi|asyncapi|swagger|\.proto$|\.graphql$|schema\.prisma$|\/contracts\/)/i;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return undefined;
  }
}

/** Changed files relative to `cwd`: diff against base (plus uncommitted changes), or the working tree. */
export function resolveChangeSet(cwd: string, options: Pick<RiskOptions, 'changedFiles' | 'base'>): { basis: DeliveryRiskScorecard['basis']; files: string[] } {
  if (options.changedFiles?.length) return { basis: 'files', files: [...new Set(options.changedFiles.map(f => f.replace(/\\/g, '/')))] };
  const lines = (out?: string) => (out ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (options.base) {
    const diff = git(cwd, ['diff', '--name-only', '--relative', `${options.base}...HEAD`]);
    if (diff === undefined) throw new Error(`Cannot diff against "${options.base}" (not a git repository or unknown ref).`);
    const local = git(cwd, ['diff', '--name-only', '--relative', 'HEAD']);
    return { basis: 'git-diff', files: [...new Set([...lines(diff), ...lines(local)])].sort() };
  }
  // Both commands print paths relative to cwd. (git status --porcelain is relative to the repository
  // root, and converting it breaks on symlinked temp dirs on macOS and 8.3 short paths on Windows.)
  const tracked = git(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--relative', 'HEAD']) ??
    git(cwd, ['-c', 'core.quotepath=off', 'ls-files', '--cached']); // repository without commits
  const untracked = git(cwd, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']);
  if (tracked === undefined && untracked === undefined) return { basis: 'specification', files: [] };
  const files = [...new Set([...lines(tracked), ...lines(untracked)])].sort();
  return files.length > 0 ? { basis: 'working-tree', files } : { basis: 'specification', files: [] };
}

interface SpecFacts {
  features: number;
  hasAuth: boolean;
  critical: boolean;
  modifications: number;
  convergence?: number;
}

function readSpecs(cwd: string, specDir: string | undefined, changed: string[] | undefined): SpecFacts {
  const facts: SpecFacts = { features: 0, hasAuth: false, critical: false, modifications: 0 };
  let dir: string;
  try {
    dir = resolveSpecDir(specDir, cwd);
  } catch {
    return facts;
  }
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.feature')).map(f => path.join(dir, f));
  // With a change set, only the specifications that changed count (all of them when none did).
  if (changed?.length) {
    const touched = files.filter(f => changed.includes(path.relative(cwd, f).replace(/\\/g, '/')));
    if (touched.length > 0) files = touched;
  }
  const convergence: number[] = [];
  for (const file of files.slice(0, 50)) {
    try {
      const parsed = parseGherkinText(fs.readFileSync(file, 'utf8'));
      const ir = buildSpecificationIR(parsed, file);
      facts.features++;
      if (ir.policies.some(p => p.type === 'authorization' || p.type === 'security')) facts.hasAuth = true;
      if ([...ir.tags, ...ir.scenarios.flatMap(s => s.tags)].some(t => /^@?(critical|business-critical|p0)$/i.test(t))) facts.critical = true;
      facts.modifications += ir.apiEndpoints.length + ir.events.length + ir.commands.length;
      if (convergence.length < 20) convergence.push(calculateConvergence(parsed, file, cwd).overallConvergence);
    } catch {
      // unparsable specs are reported by `ghk lint`
    }
  }
  if (convergence.length > 0) facts.convergence = convergence.reduce((a, b) => a + b, 0) / convergence.length;
  return facts;
}

function coveragePct(cwd: string): number | undefined {
  for (const candidate of ['coverage/coverage-summary.json', 'coverage/coverage-final-summary.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cwd, candidate), 'utf8'));
      if (typeof data?.total?.lines?.pct === 'number') return Math.round(data.total.lines.pct);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const levelFor = (score: number): RiskLevel => (score >= 75 ? 'CRITICAL' : score >= 55 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW');
export const atLeast = (level: RiskLevel, threshold: RiskLevel) => RISK_LEVELS.indexOf(level) >= RISK_LEVELS.indexOf(threshold);

export function assessDeliveryRisk(cwd: string = process.cwd(), options: RiskOptions = {}): DeliveryRiskScorecard {
  const { basis, files: changed } = resolveChangeSet(cwd, options);
  const specs = readSpecs(cwd, options.specDir ?? options.config?.specDir, basis === 'specification' ? undefined : changed);
  const sources = changed.filter(f => !isTestPath(f) && !f.endsWith('.feature') && !f.endsWith('.md'));
  const tests = changed.filter(f => isTestPath(f));

  // 1. Security
  const security: RiskDimension = { id: 'security', weight: 0.25, score: specs.hasAuth ? 80 : 20, evidence: [] };
  if (specs.hasAuth) security.evidence.push('Specifications involve authentication/authorization rules');
  const sensitive = changed.filter(f => SECURITY_PATH.test(f));
  if (sensitive.length > 0) {
    security.score = Math.max(security.score, 60 + 10 * Math.min(4, sensitive.length));
    security.evidence.push(`Security-sensitive files changed: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? '…' : ''}`);
  }
  const scanTargets = basis === 'specification' ? ['package.json', 'src/index.ts', 'gherkin-ai.config.json'] : changed;
  let content = '';
  for (const file of scanTargets.slice(0, 200)) {
    try {
      const abs = path.join(cwd, file);
      if (fs.statSync(abs).size <= 256 * 1024) content += fs.readFileSync(abs, 'utf8') + '\n';
    } catch {
      // deleted or unreadable
    }
  }
  const secrets = content ? scanContextSecurity(content).secretCount : 0;
  if (secrets > 0) {
    security.score = 100;
    security.evidence.push(`Hardcoded secrets detected (${secrets})`);
  }

  // 2. Business criticality
  const criticalGlobs = options.config?.policy?.risk?.criticalPaths ?? [];
  const configuredCritical = changed.filter(f => firstMatch(f, criticalGlobs));
  const namedCritical = changed.filter(f => CRITICAL_PATH.test(f));
  const business: RiskDimension = { id: 'businessCriticality', weight: 0.15, score: 10, evidence: [] };
  if (specs.critical) {
    business.score = 80;
    business.evidence.push('A changed specification is tagged @critical');
  }
  if (configuredCritical.length > 0) {
    business.score = Math.max(business.score, 75);
    business.evidence.push(`Files in policy.risk.criticalPaths changed: ${configuredCritical.slice(0, 5).join(', ')}`);
  } else if (namedCritical.length > 0) {
    business.score = Math.max(business.score, 50);
    business.evidence.push(`Business-critical areas changed: ${namedCritical.slice(0, 5).join(', ')}`);
  }

  // 3. Change radius
  const radius: RiskDimension = { id: 'changeRadius', weight: 0.25, score: 0, evidence: [] };
  if (basis === 'specification') {
    radius.score = clamp(specs.modifications * 10);
    if (specs.modifications > 0) radius.evidence.push(`${specs.modifications} commands, events and endpoints specified`);
  } else {
    const areas = new Set(changed.map(f => f.split('/').slice(0, 2).join('/')));
    const contracts = changed.filter(f => CONTRACT_FILES.test(f));
    radius.score = clamp(changed.length * 3 + areas.size * 8 + contracts.length * 15);
    radius.evidence.push(`${changed.length} file(s) changed across ${areas.size} area(s)`);
    if (contracts.length > 0) radius.evidence.push(`Contracts or schemas changed: ${contracts.slice(0, 5).join(', ')}`);
  }

  // 4. Test weakness (100 - test strength)
  const coverage = coveragePct(cwd);
  let strength: number;
  const testEvidence: string[] = [];
  if (coverage !== undefined) {
    strength = coverage;
    testEvidence.push(`Line coverage ${coverage}% (coverage/coverage-summary.json)`);
  } else {
    const hasTests = ['tests', 'test', 'spec', 'src/__tests__', 'src/test'].some(d => fs.existsSync(path.join(cwd, d)));
    strength = hasTests ? 40 : 0;
    testEvidence.push(hasTests ? 'Test suite present, no coverage report' : 'No tests or coverage report found');
  }
  if (sources.length > 0) {
    if (tests.length > 0) {
      strength = Math.min(100, strength + 20);
      testEvidence.push(`${tests.length} test file(s) changed with ${sources.length} source file(s)`);
    } else {
      strength = Math.max(0, strength - 20);
      testEvidence.push(`${sources.length} source file(s) changed without test changes`);
    }
  }
  const testWeakness: RiskDimension = { id: 'testWeakness', weight: 0.2, score: clamp(100 - strength), evidence: testEvidence };

  // 5. Contract drift (specification vs implementation)
  const contractDrift: RiskDimension = { id: 'contractDrift', weight: 0.1, score: 0, evidence: [] };
  if (specs.convergence !== undefined) {
    contractDrift.score = clamp(100 - specs.convergence);
    contractDrift.evidence.push(`Average spec-to-code convergence ${Math.round(specs.convergence)}% (ghk converge)`);
  } else {
    contractDrift.evidence.push('No specifications to compare against');
  }

  // 6. Architecture drift (infrastructure, CI, migrations, dependencies)
  const structural = changed.filter(f => firstMatch(f, BUILTIN_APPROVAL_PATHS) && !DEPENDENCY_FILES.test(f));
  const dependencies = changed.filter(f => DEPENDENCY_FILES.test(f));
  const architecture: RiskDimension = { id: 'architectureDrift', weight: 0.05, score: clamp(structural.length * 25 + dependencies.length * 20), evidence: [] };
  if (structural.length > 0) architecture.evidence.push(`Infrastructure, CI or migrations changed: ${structural.slice(0, 5).join(', ')}`);
  if (dependencies.length > 0) architecture.evidence.push(`Dependency manifests changed: ${dependencies.join(', ')}`);

  const dimensions = [security, business, radius, testWeakness, contractDrift, architecture];
  const overallRiskScore = clamp(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0));
  let riskLevel = levelFor(overallRiskScore);
  // Hard floors: secrets are never below HIGH; security-sensitive + business-critical + untested is CRITICAL.
  if (secrets > 0 && !atLeast(riskLevel, 'HIGH')) riskLevel = 'HIGH';
  if (security.score >= 80 && business.score >= 75 && testWeakness.score >= 80) riskLevel = 'CRITICAL';

  const approvalThreshold = options.config?.policy?.risk?.requireApprovalAt ?? 'HIGH';
  return {
    basis,
    changedFiles: changed,
    dimensions,
    blastRadius: radius.score,
    testStrength: clamp(strength),
    securitySensitivity: security.score,
    architectureDrift: architecture.score,
    overallRiskScore,
    riskLevel,
    approvalThreshold,
    requiresHumanApproval: atLeast(riskLevel, approvalThreshold),
    factors: dimensions.filter(d => d.score >= 50).flatMap(d => d.evidence)
  };
}

/** Backward-compatible entry point (whole project / working tree). */
export function calculateDeliveryRisk(cwd: string = process.cwd(), specDirOverride?: string): DeliveryRiskScorecard {
  return assessDeliveryRisk(cwd, { specDir: specDirOverride });
}
