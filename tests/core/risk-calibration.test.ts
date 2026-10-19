import { describe, it, expect } from 'vitest';
import { applyWeights, DEFAULT_RISK_WEIGHTS, RiskDimension, RiskDimensionId } from '../../src/core/risk-engine';
import { fitWeights, HistoryCommit, riskyCommits } from '../../src/core/risk-calibration';

const dims = (): RiskDimension[] => (Object.keys(DEFAULT_RISK_WEIGHTS) as RiskDimensionId[]).map(id => ({ id, weight: DEFAULT_RISK_WEIGHTS[id], score: 50, evidence: [] }));

describe('risk weights (4.4)', () => {
  it('applies policy.risk.weights over the defaults, normalized to sum 1', () => {
    const d = dims();
    applyWeights(d, { security: 0.5, testWeakness: 0.5 });
    const total = d.reduce((s, x) => s + x.weight, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(d.find(x => x.id === 'security')!.weight).toBeGreaterThan(d.find(x => x.id === 'changeRadius')!.weight);
  });

  it('labels a commit risky when a later fix touches one of its files', () => {
    const history: HistoryCommit[] = [
      { sha: '1', subject: 'feat: add payments', files: ['src/payments/pay.ts'] },
      { sha: '2', subject: 'docs: readme', files: ['README.md'] },
      { sha: '3', subject: 'fix: double charge', files: ['src/payments/pay.ts'] },
      { sha: '4', subject: 'feat: catalog', files: ['src/catalog.ts'] }
    ];
    expect([...riskyCommits(history)]).toEqual([0]);
  });

  it('moves weight toward the dimensions that separate risky commits, in proportion to the evidence', () => {
    const scores = Array.from({ length: 60 }, (_, i) => {
      const risky = i % 3 === 0;
      return { security: risky ? 90 : 20, businessCriticality: 30, changeRadius: 40, testWeakness: 50, contractDrift: 10, architectureDrift: 5 };
    });
    const risky = new Set(scores.map((_, i) => i).filter(i => i % 3 === 0));
    const fit = fitWeights(scores, risky);
    expect(fit.riskyCommits).toBe(20);
    expect(fit.evidence).toBe(0.5);
    expect(fit.weights.security).toBeGreaterThan(DEFAULT_RISK_WEIGHTS.security);
    expect(Object.values(fit.weights).reduce((s, w) => s + w, 0)).toBeCloseTo(1, 2);
    // No risky commits: the defaults stay.
    expect(fitWeights(scores, new Set()).weights).toEqual(DEFAULT_RISK_WEIGHTS);
  });
});
