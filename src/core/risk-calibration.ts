/* ==========================================================================
   gherkin-ai-cli - Risk weight calibration from the git history (4.4)

   ghk risk --calibrate [--commits 300] [--write]

   1. Each of the last N commits is scored on the six risk dimensions, with
      its own files as the change set.
   2. A commit is "risky" when a fix, hotfix, revert or rollback touches one
      of its files within the next 10 commits (SZZ-style heuristic).
   3. A dimension's learned weight grows with how much higher it scores on
      risky commits than on the others. It is blended with the default
      weight in proportion to the evidence (risky / (risky + 20)), so a short
      or quiet history barely moves the defaults.
   Deterministic and explainable: the report lists each dimension's mean
   score on risky and on other commits.
   ========================================================================== */

import { execFileSync } from 'child_process';
import type { GherkinAIConfig } from './config';
import { assessDeliveryRisk, DEFAULT_RISK_WEIGHTS, RiskDimensionId } from './risk-engine';

export interface HistoryCommit {
  sha: string;
  subject: string;
  files: string[];
}

export interface DimensionCalibration {
  id: RiskDimensionId;
  meanRisky: number;
  meanOther: number;
  defaultWeight: number;
  weight: number;
}

export interface RiskCalibration {
  commits: number;
  riskyCommits: number;
  /** Share of the learned weights in the result (0 = defaults only). */
  evidence: number;
  dimensions: DimensionCalibration[];
  weights: Record<RiskDimensionId, number>;
}

const FIX_SUBJECT = /\b(fix(es|ed)?|hotfix|revert(s|ed)?|bug|regression|rollback|roll back)\b/i;
const FOLLOW_UP_WINDOW = 10;
const SHRINKAGE = 20;
const IDS = Object.keys(DEFAULT_RISK_WEIGHTS) as RiskDimensionId[];

/** The last `limit` non-merge commits that changed files, oldest first. */
export function readHistory(cwd: string, limit: number): HistoryCommit[] {
  let out: string;
  try {
    out = execFileSync('git', ['-c', 'core.quotepath=off', 'log', '--no-merges', `-n${limit}`, '--relative', '--name-only', '--format=%x1e%H%x1f%s'],
      { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    throw new Error('ghk risk --calibrate needs a git repository with history.');
  }
  return out.split('\x1e').filter(Boolean).map(block => {
    const [head, ...rest] = block.split('\n');
    const [sha, subject] = head.split('\x1f');
    return { sha, subject: subject ?? '', files: rest.map(l => l.trim()).filter(Boolean) };
  }).filter(c => c.files.length > 0).reverse();
}

/** Indexes of commits a later fix touches (within the follow-up window). */
export function riskyCommits(history: HistoryCommit[]): Set<number> {
  const risky = new Set<number>();
  history.forEach((commit, i) => {
    const files = new Set(commit.files);
    for (let j = i + 1; j <= Math.min(history.length - 1, i + FOLLOW_UP_WINDOW); j++) {
      if (FIX_SUBJECT.test(history[j].subject) && history[j].files.some(f => files.has(f))) {
        risky.add(i);
        break;
      }
    }
  });
  return risky;
}

/** Fits the weights from per-commit dimension scores and the risky labels. */
export function fitWeights(scores: Record<RiskDimensionId, number>[], risky: Set<number>): RiskCalibration {
  const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0);
  const evidence = risky.size / (risky.size + SHRINKAGE);
  const separation = IDS.map(id => {
    const meanRisky = mean(scores.filter((_, i) => risky.has(i)).map(s => s[id]));
    const meanOther = mean(scores.filter((_, i) => !risky.has(i)).map(s => s[id]));
    return { id, meanRisky, meanOther, learned: Math.max(0, meanRisky - meanOther) + 1 };
  });
  const learnedTotal = separation.reduce((s, d) => s + d.learned, 0);
  const blended = separation.map(d => ({ ...d, raw: evidence * (d.learned / learnedTotal) + (1 - evidence) * DEFAULT_RISK_WEIGHTS[d.id] }));
  const total = blended.reduce((s, d) => s + d.raw, 0);
  const dimensions = blended.map(d => ({
    id: d.id,
    meanRisky: Math.round(d.meanRisky),
    meanOther: Math.round(d.meanOther),
    defaultWeight: DEFAULT_RISK_WEIGHTS[d.id],
    weight: Math.round((d.raw / total) * 1000) / 1000
  }));
  return {
    commits: scores.length,
    riskyCommits: risky.size,
    evidence: Math.round(evidence * 100) / 100,
    dimensions,
    weights: Object.fromEntries(dimensions.map(d => [d.id, d.weight])) as Record<RiskDimensionId, number>
  };
}

export function calibrateRiskWeights(cwd: string, config: Partial<GherkinAIConfig>, limit = 300): RiskCalibration {
  const history = readHistory(cwd, limit);
  // Score with the default weights: calibration must not depend on earlier calibrations.
  const neutral = { ...config, policy: { ...config.policy, risk: { ...config.policy?.risk, weights: undefined } } };
  const scores = history.map(c => {
    const card = assessDeliveryRisk(cwd, { config: neutral, changedFiles: c.files });
    return Object.fromEntries(card.dimensions.map(d => [d.id, d.score])) as Record<RiskDimensionId, number>;
  });
  return fitWeights(scores, riskyCommits(history));
}
