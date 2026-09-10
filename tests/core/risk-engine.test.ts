import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { calculateDeliveryRisk } from '../../src/core/risk-engine';

describe('Delivery Risk Engine', () => {
  const testDir = path.join(process.cwd(), '.test-risk-engine');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('should calculate baseline risk when no features or tests exist', () => {
    const riskCard = calculateDeliveryRisk(testDir);
    expect(riskCard.blastRadius).toBe(0);
    expect(riskCard.testStrength).toBe(0);
    expect(riskCard.securitySensitivity).toBe(20);
    expect(riskCard.overallRiskScore).toBeGreaterThanOrEqual(0);
    expect(riskCard.riskLevel).toBeDefined();
  });

  it('should increase blast radius when features exist', () => {
    const specDir = path.join(testDir, 'features');
    fs.mkdirSync(specDir);
    const validFeature = `Feature: User Registration
  Scenario: Successful registration
    Given something
    When user executes "RegisterCommand"
    Then the system returns HTTP status 201`;
    fs.writeFileSync(path.join(specDir, 'test.feature'), validFeature);
    
    const riskCard = calculateDeliveryRisk(testDir, 'features');
    // It should parse and find an endpoint due to HTTP status 201
    expect(riskCard.blastRadius).toBeGreaterThan(0);
  });

  it('should increase test strength when coverage file exists', () => {
    const coverageDir = path.join(testDir, 'coverage');
    fs.mkdirSync(coverageDir);
    const coverageData = { total: { lines: { pct: 85 } } };
    fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), JSON.stringify(coverageData));
    
    const riskCard = calculateDeliveryRisk(testDir);
    expect(riskCard.testStrength).toBe(85);
  });

  it('should set test strength to 40 if tests dir exists but no coverage', () => {
    fs.mkdirSync(path.join(testDir, 'tests'));
    const riskCard = calculateDeliveryRisk(testDir);
    expect(riskCard.testStrength).toBe(40);
  });

  it('should increase security sensitivity to 100 when secrets are found', () => {
    fs.writeFileSync(path.join(testDir, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(testDir, 'gherkin-ai.config.json'),
      'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"'
    );
    
    const riskCard = calculateDeliveryRisk(testDir);
    expect(riskCard.securitySensitivity).toBe(100);
  });

  it('should require human approval if risk is HIGH', () => {
    fs.writeFileSync(path.join(testDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(testDir, 'gherkin-ai.config.json'), 'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"');
    
    const specDir = path.join(testDir, 'features');
    fs.mkdirSync(specDir);
    // Write 10 events to get 100 blast radius
    const validFeature = `Feature: User Registration
  Scenario: Auth
    Given an authenticated administrator
    When the user executes "AuthCommand"
    Then emits "Event1" event
    Then emits "Event2" event
    Then emits "Event3" event
    Then emits "Event4" event
    Then emits "Event5" event
    Then emits "Event6" event
    Then emits "Event7" event
    Then emits "Event8" event
    Then emits "Event9" event
    Then emits "Event10" event
    Then the system returns HTTP status 200`;
    fs.writeFileSync(path.join(specDir, 'test.feature'), validFeature);

    const riskCard = calculateDeliveryRisk(testDir, 'features');
    expect(riskCard.requiresHumanApproval).toBe(true);
    expect(riskCard.riskLevel).toBe('CRITICAL');
  });
});
