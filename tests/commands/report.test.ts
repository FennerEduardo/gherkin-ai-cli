import { describe, it, expect } from 'vitest';
import { githubAnnotations, gitlabCodeQuality, markdownSummary, FeatureReport } from '../../src/commands/report';

const features: FeatureReport[] = [{
  file: 'features/pay.feature',
  feature: 'Payments, v2',
  lintScore: 64,
  passed: false,
  convergence: 71,
  diagnostics: [
    { ruleId: 'GHK015', severity: 'warning', message: 'Aggregate name has more than 4 words.', suggestion: 'Use @aggregate:Payment.', line: 3 },
    { ruleId: 'GHK016', severity: 'info', message: '100% generic:\ncommands' }
  ]
}];

describe('ghk report (4.7)', () => {
  it('writes GitHub annotations on the feature lines, escaping workflow-command data', () => {
    const [warning, notice] = githubAnnotations(features);
    expect(warning).toBe('::warning file=features/pay.feature,line=3,title=GHK015 Payments%2C v2::Aggregate name has more than 4 words. Use @aggregate:Payment.');
    expect(notice).toBe('::notice file=features/pay.feature,line=1,title=GHK016 Payments%2C v2::100%25 generic:%0Acommands');
  });

  it('writes a GitLab Code Quality report with stable fingerprints', () => {
    const report = gitlabCodeQuality(features) as any[];
    expect(report[0]).toMatchObject({ check_name: 'GHK015', severity: 'minor', location: { path: 'features/pay.feature', lines: { begin: 3 } } });
    expect(report[1].severity).toBe('info');
    expect(report[0].fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(gitlabCodeQuality(features)).toEqual(report);
  });

  it('summarizes scores and risk in Markdown', () => {
    const md = markdownSummary(features, undefined, 70, '3.2.0');
    expect(md).toContain('| ❌ `features/pay.feature` | 64/100 | 71% | 2 |');
    expect(md).toContain('not assessed');
  });
});
