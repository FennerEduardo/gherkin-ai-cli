import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SpecHashBaseline } from '../../src/core/governance/spec-hash-baseline';
import { AgentPolicyEngine } from '../../src/core/governance/agent-policy-engine';

describe('Governance & Guardrails Engine', () => {
  const tmpDir = path.join(process.cwd(), 'scratch', 'test-governance');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('calculates deterministic SHA-256 hashes and detects spec drift', () => {
    const featureFile = path.join(tmpDir, 'sample.feature');
    fs.writeFileSync(featureFile, 'Feature: Test\nScenario: A\nGiven ok', 'utf8');

    const baseline = new SpecHashBaseline(tmpDir);
    baseline.updateBaselines([featureFile]);

    // Initial check should pass with no drift
    const check1 = baseline.verifyDrift([featureFile]);
    expect(check1.hasDrift).toBe(false);
    expect(check1.modifiedFiles.length).toBe(0);

    // Modify file
    fs.writeFileSync(featureFile, 'Feature: Test Modified\nScenario: A\nGiven modified', 'utf8');
    const check2 = baseline.verifyDrift([featureFile]);
    expect(check2.hasDrift).toBe(true);
    expect(check2.modifiedFiles.length).toBe(1);
  });

  it('enforces agent policy boundaries and human approval rules', () => {
    const policyEngine = new AgentPolicyEngine(tmpDir);

    // Allowed files
    const allowedRes = policyEngine.evaluateFileModifications(['src/index.ts', 'specs/test.feature']);
    expect(allowedRes.allowed).toBe(true);
    expect(allowedRes.violations.length).toBe(0);

    // Protected file violation
    const protectedRes = policyEngine.evaluateFileModifications(['.env', 'src/secrets.ts']);
    expect(protectedRes.allowed).toBe(false);
    expect(protectedRes.violations.length).toBeGreaterThan(0);

    // File requiring human approval
    const approvalRes = policyEngine.evaluateFileModifications(['schema.prisma']);
    expect(approvalRes.requiresApproval).toBe(true);
    expect(approvalRes.approvalReasons.length).toBeGreaterThan(0);
  });
});
