import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { lintSpecification, getAvailableRules } from '../../src/core/specification-linter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AMBIGUOUS_FEATURE = `Feature: Vague Feature
  Scenario: Do something
    Given something exists
    When the system works somehow
    Then everything is correct
`;

const NO_ACTOR_FEATURE = `Feature: System process
  Scenario: Batch run
    Given records exist
    When the cron job runs
    Then records are updated
`;

const NO_OUTCOME_FEATURE = `Feature: Incomplete
  Scenario: Missing Then
    Given a user
    When the user clicks save
`;

const DUPLICATE_FEATURE = `Feature: Duplicates
  Scenario: Login
    Given user
    When login
    Then success
    
  Scenario: Login
    Given user
    When login
    Then success
`;

const CONTRADICTORY_FEATURE = `Feature: Contradictions
  Scenario: Turn on
    Given a device with status "IDLE"
    When the user toggles power
    Then the status is "ON"
    
  Scenario: Turn off
    Given a device with status "IDLE"
    When the user toggles power
    Then the status is "OFF"
`;

const IMPLEMENTATION_LEAK_FEATURE = `Feature: Tech Leak
  Scenario: Save to DB
    Given a SQL database
    When the user clicks the button
    Then a record is inserted into the table
`;

const COMPLEX_FEATURE = `Feature: Complex
  Scenario: Too many steps
    Given 1
    And 2
    And 3
    And 4
    And 5
    And 6
    When 7
    Then 8
    And 9
    And 10
    And 11
`;

const GOOD_FEATURE = `Feature: User Registration
  As an administrator
  I want to register users
  
  Scenario: Successful registration
    Given an authenticated administrator
    When the admin registers a user with email "test@test.com"
    Then the user is created with status "ACTIVE"
    And the system returns HTTP status 201
    
  Scenario: Registration failure
    Given an authenticated administrator
    When the admin registers an invalid email
    Then a validation error is returned
    And the system returns HTTP status 400
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Specification Linter', () => {
  describe('lintSpecification()', () => {
    it('should pass a well-written feature', () => {
      const parsed = parseGherkinText(GOOD_FEATURE);
      const result = lintSpecification(parsed);
      
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThan(80);
      
      // Some rules might still trigger as warnings (e.g., missing observability)
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      expect(errors.length).toBe(0);
    });

    it('should detect ambiguous language (GHK001)', () => {
      const parsed = parseGherkinText(AMBIGUOUS_FEATURE);
      const result = lintSpecification(parsed);
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK001');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
    });

    it('should detect missing actors (GHK002)', () => {
      const parsed = parseGherkinText(NO_ACTOR_FEATURE);
      const result = lintSpecification(parsed);
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK002');
      expect(diag).toBeDefined();
    });

    it('should detect missing outcomes (GHK003)', () => {
      const parsed = parseGherkinText(NO_OUTCOME_FEATURE);
      const result = lintSpecification(parsed);
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK003');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('error');
      expect(result.score).toBeLessThan(100);
    });

    it('should detect duplicated scenarios (GHK004)', () => {
      const parsed = parseGherkinText(DUPLICATE_FEATURE);
      const result = lintSpecification(parsed);
      
      const diags = result.diagnostics.filter(d => d.ruleId === 'GHK004');
      expect(diags.length).toBeGreaterThan(0);
    });

    it('should detect contradictory rules (GHK005)', () => {
      const parsed = parseGherkinText(CONTRADICTORY_FEATURE);
      const result = lintSpecification(parsed);
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK005');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('error');
    });

    it('should detect implementation leakage (GHK007)', () => {
      const parsed = parseGherkinText(IMPLEMENTATION_LEAK_FEATURE);
      const result = lintSpecification(parsed);
      
      const diags = result.diagnostics.filter(d => d.ruleId === 'GHK007');
      expect(diags.length).toBeGreaterThanOrEqual(2); // Should catch SQL and table/button
    });

    it('should detect excessive complexity (GHK008)', () => {
      const parsed = parseGherkinText(COMPLEX_FEATURE);
      const result = lintSpecification(parsed);
      
      const diags = result.diagnostics.filter(d => d.ruleId === 'GHK008');
      expect(diags.length).toBeGreaterThan(0);
    });

    it('should detect missing error paths (GHK009)', () => {
      // AMBIGUOUS_FEATURE has no error scenarios
      const parsed = parseGherkinText(AMBIGUOUS_FEATURE);
      const result = lintSpecification(parsed);
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK009');
      expect(diag).toBeDefined();
    });

    it('should allow disabling rules', () => {
      const parsed = parseGherkinText(AMBIGUOUS_FEATURE);
      const result = lintSpecification(parsed, 'test.feature', { disabledRules: ['GHK001'] });
      
      const diag = result.diagnostics.find(d => d.ruleId === 'GHK001');
      expect(diag).toBeUndefined();
    });

    it('should fail if score drops below threshold', () => {
      const parsed = parseGherkinText(NO_OUTCOME_FEATURE);
      // NO_OUTCOME_FEATURE triggers GHK003 (error, -15), GHK009 (warn, -5), GHK013 (error, -15), GHK010, GHK002
      // Score will be low. Set threshold to 90.
      const result = lintSpecification(parsed, 'test.feature', { threshold: 90 });
      
      expect(result.passed).toBe(false);
    });
  });

  describe('getAvailableRules()', () => {
    it('should return a list of all defined rules', () => {
      const rules = getAvailableRules();
      expect(rules.length).toBeGreaterThan(10);
      
      const ruleIds = rules.map(r => r.id);
      expect(ruleIds).toContain('GHK001');
      expect(ruleIds).toContain('GHK014');
      
      expect(rules[0].name).toBeDefined();
      expect(rules[0].severity).toBeDefined();
    });
  });
});
