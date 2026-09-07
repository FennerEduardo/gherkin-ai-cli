import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { calculateQualityScorecard } from '../../src/core/quality-score';

describe('Quality Scorecard Engine', () => {
  const testDir = path.join(process.cwd(), '.test-quality-score');

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

  it('should calculate a baseline score when no features or tests exist', () => {
    const scorecard = calculateQualityScorecard(testDir);
    
    // Without features, spec score is 0
    expect(scorecard.specificationScore).toBe(0);
    expect(scorecard.unitTestsScore).toBe(0);
    // Base type safety score
    expect(scorecard.typeSafetyScore).toBe(70);
    // Overall score is weighted sum
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.passedQualityGate).toBe(false);
  });

  it('should increase specification score when valid features exist', () => {
    const specDir = path.join(testDir, 'features');
    fs.mkdirSync(specDir);
    
    // Write a valid feature
    const validFeature = `Feature: User Registration
  As an administrator
  I want to register users
  
  Scenario: Successful registration
    Given an authenticated administrator
    When the admin registers a user with email "test@test.com"
    Then the user is created with status "ACTIVE"
    And the system returns HTTP status 201`;
    fs.writeFileSync(path.join(specDir, 'test.feature'), validFeature);
    
    const scorecard = calculateQualityScorecard(testDir, 'features');
    expect(scorecard.specificationScore).toBeGreaterThan(0);
  });

  it('should increase unit test score when coverage file exists', () => {
    const coverageDir = path.join(testDir, 'coverage');
    fs.mkdirSync(coverageDir);
    
    const coverageData = { total: { lines: { pct: 85 } } };
    fs.writeFileSync(
      path.join(coverageDir, 'coverage-summary.json'),
      JSON.stringify(coverageData)
    );
    
    const scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.unitTestsScore).toBe(85);
    expect(scorecard.integrationTestsScore).toBe(Math.round(85 * 0.75));
  });

  it('should set unit test score to 60 if tests dir exists but no coverage', () => {
    fs.mkdirSync(path.join(testDir, 'tests'));
    
    const scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.unitTestsScore).toBe(60);
  });

  it('should increase e2e score if cypress/playwright/e2e dirs exist', () => {
    fs.mkdirSync(path.join(testDir, 'playwright'));
    
    const scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.e2eTestsScore).toBe(80);
  });

  it('should increase type safety score based on ecosystem files', () => {
    // TypeScript
    fs.writeFileSync(path.join(testDir, 'tsconfig.json'), '{}');
    let scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.typeSafetyScore).toBe(80); // 80 because node_modules doesn't exist
    
    // Java
    fs.rmSync(path.join(testDir, 'tsconfig.json'));
    fs.writeFileSync(path.join(testDir, 'pom.xml'), '<project></project>');
    scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.typeSafetyScore).toBe(95);
    
    // Rust
    fs.rmSync(path.join(testDir, 'pom.xml'));
    fs.writeFileSync(path.join(testDir, 'Cargo.toml'), '');
    scorecard = calculateQualityScorecard(testDir);
    expect(scorecard.typeSafetyScore).toBe(100);
  });

  it('should decrease security score when secrets are found in project files', () => {
    fs.writeFileSync(path.join(testDir, 'package-lock.json'), '{}');
    fs.writeFileSync(
      path.join(testDir, 'gherkin-ai.config.json'),
      'api_key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"'
    );
    
    const scorecard = calculateQualityScorecard(testDir);
    // Base 100 - 50 (secret) = 50
    expect(scorecard.securityScore).toBe(50);
  });

  it('should decrease security score when lockfile is missing', () => {
    // No lockfile created
    const scorecard = calculateQualityScorecard(testDir);
    // Base 100 - 15 (no lockfile) = 85
    expect(scorecard.securityScore).toBe(85);
  });

  it('should pass quality gate for highly scored projects', () => {
    // Setup high score conditions
    const specDir = path.join(testDir, 'features');
    fs.mkdirSync(specDir);
    const validFeature = `Feature: User Registration
  As an administrator
  I want to register users
  
  Scenario: Successful registration
    Given an authenticated administrator
    When the admin registers a user with email "test@test.com"
    Then the user is created with status "ACTIVE"
    And the system returns HTTP status 201`;
    fs.writeFileSync(path.join(specDir, 'test.feature'), validFeature);
    
    const coverageDir = path.join(testDir, 'coverage');
    fs.mkdirSync(coverageDir);
    fs.writeFileSync(path.join(coverageDir, 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 90 } } }));
    
    fs.writeFileSync(path.join(testDir, 'Cargo.toml'), ''); // Type safety 100
    fs.writeFileSync(path.join(testDir, 'Cargo.lock'), ''); // Security lockfile
    
    const scorecard = calculateQualityScorecard(testDir, 'features');
    
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(70);
    expect(scorecard.passedQualityGate).toBe(true);
  });
});
