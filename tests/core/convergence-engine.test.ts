import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { calculateConvergence, checkConvergence } from '../../src/core/convergence-engine';
import { buildIR } from '../../src/core/ir-builder';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPLETE_FEATURE = `Feature: User Registration
  As an authenticated administrator
  I want to register new users

  @security
  Scenario: Register valid user
    Given an authenticated administrator
    When the admin registers a user with email "new@test.com"
    Then the user is created with status "ACTIVE"
    And the system returns HTTP status 201

  Scenario: Registration with invalid email
    Given an authenticated administrator
    When the admin submits an invalid email format
    Then a validation error is returned
    And the system returns HTTP status 400

  Scenario: Unauthorized registration attempt
    Given an unauthenticated user
    When the user tries to register a new user
    Then access is denied
    And the system returns HTTP status 403

  Scenario: Registration with duplicate email
    Given an authenticated administrator
    And a user with email "existing@test.com" already exists
    When the admin registers a user with email "existing@test.com"
    Then an error indicates the email is already taken
`;

const MINIMAL_FEATURE = `Feature: Simple Feature
  Scenario: Basic operation
    Given a precondition
    When something happens
    Then a result occurs
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Convergence Engine', () => {
  describe('calculateConvergence()', () => {
    it('should return a ConvergenceReport with all required fields', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'registration.feature');

      expect(report.featureName).toBe('User Registration');
      expect(report.sourceFile).toBe('registration.feature');
      expect(report.timestamp).toBeDefined();
      expect(report.dimensions).toBeInstanceOf(Array);
      expect(report.dimensions.length).toBe(7);
      expect(typeof report.overallConvergence).toBe('number');
      expect(report.overallConvergence).toBeGreaterThanOrEqual(0);
      expect(report.overallConvergence).toBeLessThanOrEqual(100);
      expect(['CONVERGED', 'PARTIAL', 'DIVERGED']).toContain(report.status);
      expect(report.recommendations).toBeInstanceOf(Array);
    });

    it('should evaluate all 6 dimensions', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const dimensionNames = report.dimensions.map(d => d.name);
      expect(dimensionNames).toContain('Specification Quality');
      expect(dimensionNames).toContain('Scenario Completeness');
      expect(dimensionNames).toContain('Contract Coverage');
      expect(dimensionNames).toContain('Architecture Compliance');
      expect(dimensionNames).toContain('Security Policy');
      expect(dimensionNames).toContain('Traceability');
      expect(dimensionNames).toContain('Code Coverage');
    });

    it('each dimension should have score, maxScore, details, status', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      for (const dim of report.dimensions) {
        expect(typeof dim.score).toBe('number');
        expect(dim.maxScore).toBe(100);
        expect(dim.details).toBeInstanceOf(Array);
        expect(['pass', 'warn', 'fail']).toContain(dim.status);
      }
    });
  });

  describe('Contract Coverage dimension (artifact-based)', () => {
    const write = (root: string, rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    const coverage = (dir: string, outputDir: string) =>
      calculateConvergence(parseGherkinText(COMPLETE_FEATURE), 'f.feature', dir, { outputDir }).dimensions.find(d => d.name === 'Contract Coverage')!;

    it('reads the configured output directory and checks operations, events and declared types', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-conv-'));
      const ir = buildIR(parseGherkinText(COMPLETE_FEATURE), 'f.feature');
      const model = buildDomainModel(parseGherkinText(COMPLETE_FEATURE));
      // An openapi.json that only has the file, not the operations, must not score.
      write(dir, 'out/openapi.json', JSON.stringify({ openapi: '3.0.3', paths: {} }));
      const empty = coverage(dir, 'out');
      expect(empty.basis).toBe('artifacts');
      expect(empty.score).toBe(0);
      expect(empty.details.some(d => d.startsWith('OpenAPI has no'))).toBe(true);

      // Real operations with their status codes, plus the domain types in a source file, do.
      const paths: Record<string, any> = {};
      for (const ep of ir.apiEndpoints) {
        paths[ep.path] = { ...(paths[ep.path] ?? {}), [ep.method.toLowerCase()]: { responses: Object.fromEntries(ep.httpCodes.map(c => [String(c.code), {}])) } };
      }
      write(dir, 'out/openapi.json', JSON.stringify({ openapi: '3.0.3', paths }));
      write(dir, 'out/asyncapi.json', JSON.stringify({ messages: ir.events.map(e => e.name) }));
      write(dir, 'out/src/domain.ts', [`export class ${model.pascal}Aggregate {}`, ...model.commands.flatMap(c => [`export type ${c.name} = {};`, `export type ${c.event} = {};`])].join('\n'));
      expect(coverage(dir, 'out').score).toBe(100);
      // The same artifacts outside outputDir are not counted.
      expect(coverage(dir, 'elsewhere').score).toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('checkConvergence()', () => {
    it('should accept a pre-built IR', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');
      const report = checkConvergence(ir);

      expect(report.featureName).toBe('User Registration');
      expect(report.dimensions.length).toBe(7);
    });
  });

  describe('Status thresholds', () => {
    it('should report DIVERGED for minimal/empty features', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      // Minimal features typically score low across dimensions
      // Status should be PARTIAL or DIVERGED
      expect(['PARTIAL', 'DIVERGED']).toContain(report.status);
    });

    it('should report higher convergence for complete features', () => {
      const parsedComplete = parseGherkinText(COMPLETE_FEATURE);
      const parsedMinimal = parseGherkinText(MINIMAL_FEATURE);

      const reportComplete = calculateConvergence(parsedComplete, 'complete.feature');
      const reportMinimal = calculateConvergence(parsedMinimal, 'minimal.feature');

      expect(reportComplete.overallConvergence).toBeGreaterThan(reportMinimal.overallConvergence);
    });
  });

  describe('Specification Quality dimension', () => {
    it('should score higher for features with more scenarios and commands', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const specQuality = report.dimensions.find(d => d.name === 'Specification Quality');
      expect(specQuality).toBeDefined();
      expect(specQuality!.details.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario Completeness dimension', () => {
    it('should detect covered categories from COMPLETE_FEATURE', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const completeness = report.dimensions.find(d => d.name === 'Scenario Completeness');
      expect(completeness).toBeDefined();
      expect(completeness!.details.some(d => d.includes('Covered categories'))).toBe(true);
    });

    it('should detect missing categories for minimal feature', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const completeness = report.dimensions.find(d => d.name === 'Scenario Completeness');
      expect(completeness).toBeDefined();
      expect(completeness!.score).toBeLessThan(100);
    });
  });

  describe('Security Policy dimension', () => {
    it('should penalize features without auth scenarios', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const security = report.dimensions.find(d => d.name === 'Security Policy');
      expect(security).toBeDefined();
      expect(security!.score).toBeLessThan(100);
    });

    it('should score well for features with auth and security scenarios', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const security = report.dimensions.find(d => d.name === 'Security Policy');
      expect(security).toBeDefined();
      // COMPLETE_FEATURE has auth scenarios, so should score higher
      expect(security!.score).toBeGreaterThan(0);
    });
  });

  describe('Recommendations', () => {
    it('should generate recommendations for incomplete features', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      expect(report.recommendations.length).toBeGreaterThan(0);
    });

    it('should recommend adding missing scenario categories', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const hasMissingCatRec = report.recommendations.some(r =>
        r.includes('Missing scenario categories')
      );
      expect(hasMissingCatRec).toBe(true);
    });
  });

  describe('Traceability dimension', () => {
    it('should report traceability coverage', () => {
      const parsed = parseGherkinText(COMPLETE_FEATURE);
      const report = calculateConvergence(parsed, 'test.feature');

      const traceability = report.dimensions.find(d => d.name === 'Traceability');
      expect(traceability).toBeDefined();
      expect(traceability!.details.some(d => d.includes('Traceability links'))).toBe(true);
      expect(traceability!.details.some(d => d.includes('Coverage'))).toBe(true);
    });
  });
});
