import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assessDeliveryRisk, calculateDeliveryRisk, resolveChangeSet } from '../../src/core/risk-engine';

let dir: string;
const write = (rel: string, content = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const dimension = (card: ReturnType<typeof assessDeliveryRisk>, id: string) => card.dimensions.find(d => d.id === id)!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-risk-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('delivery risk engine', () => {
  it('assesses the whole specification when there is no change set', () => {
    const card = calculateDeliveryRisk(dir);
    expect(card.basis).toBe('specification');
    expect(card.blastRadius).toBe(0);
    expect(card.testStrength).toBe(0);
    expect(card.securitySensitivity).toBe(20);
    expect(card.dimensions.map(d => d.id)).toEqual(['security', 'businessCriticality', 'changeRadius', 'testWeakness', 'contractDrift', 'architectureDrift']);
    expect(card.dimensions.reduce((s, d) => s + d.weight, 0)).toBeCloseTo(1);
    expect(card.riskLevel).toBe('LOW');
  });

  it('counts specified commands, events and endpoints as change radius', () => {
    write('features/registration.feature', `Feature: User Registration
  Scenario: Successful registration
    When processing user registration request
    Then the system responds with HTTP status 201
    And emits a "UserRegistered" domain event
`);
    const card = assessDeliveryRisk(dir, { specDir: 'features' });
    expect(card.blastRadius).toBeGreaterThan(0);
    expect(dimension(card, 'contractDrift').evidence[0]).toMatch(/convergence/);
  });

  it('uses the coverage report for test strength', () => {
    write('coverage/coverage-summary.json', JSON.stringify({ total: { lines: { pct: 85 } } }));
    expect(calculateDeliveryRisk(dir).testStrength).toBe(85);
  });

  it('scores an explicit change set by its content', () => {
    write('src/auth/jwt.strategy.ts', 'export const x = 1;');
    write('src/payments/refund.service.ts', 'export const y = 2;');
    write('prisma/migrations/001/migration.sql', 'ALTER TABLE x;');
    write('package.json', '{}');
    const card = assessDeliveryRisk(dir, { changedFiles: ['src/auth/jwt.strategy.ts', 'src/payments/refund.service.ts', 'prisma/migrations/001/migration.sql', 'package.json'] });
    expect(card.basis).toBe('files');
    expect(dimension(card, 'security').score).toBeGreaterThanOrEqual(70);
    expect(dimension(card, 'businessCriticality').score).toBe(50);
    expect(dimension(card, 'architectureDrift').evidence.join(' ')).toMatch(/migrations.*Dependency manifests/s);
    expect(dimension(card, 'testWeakness').evidence.join(' ')).toMatch(/without test changes/);
    expect(['MEDIUM', 'HIGH', 'CRITICAL']).toContain(card.riskLevel);
  });

  it('never rates hardcoded secrets below HIGH', () => {
    write('src/config.ts', 'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz1234567890";');
    const card = assessDeliveryRisk(dir, { changedFiles: ['src/config.ts'] });
    expect(card.securitySensitivity).toBe(100);
    expect(['HIGH', 'CRITICAL']).toContain(card.riskLevel);
    expect(card.requiresHumanApproval).toBe(true);
  });

  it('applies policy.risk: critical paths and the approval threshold', () => {
    write('src/core/pricing.ts', 'export const p = 1;');
    const config = { policy: { risk: { criticalPaths: ['src/core/pricing.ts'], requireApprovalAt: 'LOW' as const } } };
    const card = assessDeliveryRisk(dir, { changedFiles: ['src/core/pricing.ts'], config });
    expect(dimension(card, 'businessCriticality').score).toBe(75);
    expect(card.approvalThreshold).toBe('LOW');
    expect(card.requiresHumanApproval).toBe(true);
  });

  it('reads the change set from git', () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      run('init', '-q');
    } catch {
      return; // git not available
    }
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    write('src/orders/order.ts', 'export {};');
    write('tests/order.test.ts', 'export {};');
    const changes = resolveChangeSet(dir, {});
    expect(changes.basis).toBe('working-tree');
    expect(changes.files).toEqual(['src/orders/order.ts', 'tests/order.test.ts']);
    expect(() => resolveChangeSet(dir, { base: 'no-such-ref' })).toThrow(/Cannot diff/);
  });
});
