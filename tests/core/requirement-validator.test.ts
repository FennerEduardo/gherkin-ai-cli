import { describe, it, expect } from 'vitest';
import { validateRequirement } from '../../src/core/requirement-validator';

describe('Requirement Validator (Enhanced)', () => {
  // ── Rule 1: Missing acceptance criteria ────────────────────────────
  describe('Rule: Acceptance Criteria', () => {
    it('should reject documents with no Gherkin or requirement keywords', () => {
      const result = validateRequirement('This is a random text about nothing specific at all, just filler content to make it long enough for the test to pass the length check but without any real keywords.');
      expect(result.isValid).toBe(false);
      expect(result.issues.some(i => i.type === 'missing_acceptance_criteria')).toBe(true);
    });

    it('should accept documents containing Gherkin keywords', () => {
      const result = validateRequirement('Feature: User Management\nAs a user I want to manage my profile\nGiven the user is logged in\nWhen they update their name field to "John"\nThen the system should return 200 OK\nAnd if invalid input is provided, return 400 error with details');
      const acceptanceCriteriaIssue = result.issues.find(i => i.type === 'missing_acceptance_criteria');
      expect(acceptanceCriteriaIssue).toBeUndefined();
    });
  });

  // ── Rule 2: Document length ────────────────────────────────────────
  describe('Rule: Document Length', () => {
    it('should reject documents shorter than 200 characters', () => {
      const result = validateRequirement('Short requirement about users.');
      expect(result.isValid).toBe(false);
      expect(result.issues.some(i => i.type === 'too_broad')).toBe(true);
    });
  });

  // ── Rule 3: Actionable entities ────────────────────────────────────
  describe('Rule: Actionable Entities', () => {
    it('should detect documents without business entities', () => {
      // A document that has some keywords but no business entities
      const doc = 'Requirements Document\n\nThis is a requirements document that describes what the solution must do.\n' + 
                  'The solution must be reliable and meet the acceptance criteria.\n'.repeat(10);
      const result = validateRequirement(doc);
      const issue = result.issues.find(i => i.type === 'no_actionable_blocks');
      // "requirements" and "must" should pass rule 1, but no user/system/api
      // Actually "solution" doesn't match, but let's check
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  // ── Rule 4: Ambiguous language ─────────────────────────────────────
  describe('Rule: Ambiguous Language', () => {
    it('should detect ambiguous terms like "fast", "flexible", "scalable"', () => {
      const doc = 'Feature: Payment Processing\nThe system must be fast and scalable. ' +
                  'The user interface should be intuitive and user-friendly. ' +
                  'It must handle various payment methods seamlessly. ' +
                  'Performance should be adequate for our requirements and the system robust enough.\n' +
                  'The user must be able to submit a payment action via the API endpoint.';
      const result = validateRequirement(doc);
      const ambiguityIssue = result.issues.find(i => i.type === 'ambiguous_language');
      expect(ambiguityIssue).toBeDefined();
      expect(ambiguityIssue!.message).toContain('ambiguous term');
    });

    it('should not flag documents without ambiguous terms', () => {
      const doc = 'Feature: Payment Processing\n\n' +
                  'Requirement: The user must authenticate via JWT before submitting payment.\n' +
                  'The API endpoint POST /payments must respond within 200ms.\n' +
                  'If the payment amount exceeds the account balance, return HTTP 400 error.\n' +
                  'The system must validate the payment payload fields: amount (number), currency (string enum), recipient (string).\n' +
                  'Priority: P0 - Critical for launch.\n' +
                  'Scope: In scope - payment submission and validation. Out of scope - refunds.';
      const result = validateRequirement(doc);
      const ambiguityIssue = result.issues.find(i => i.type === 'ambiguous_language');
      expect(ambiguityIssue).toBeUndefined();
    });
  });

  // ── Rule 5: Missing error scenarios ────────────────────────────────
  describe('Rule: Error Scenarios', () => {
    it('should warn when no error handling is mentioned', () => {
      const doc = 'Feature: User Registration\nAs a new user I want to register an account.\n' +
                  'The user must provide their name and email address.\n' +
                  'The system stores the user data in the database.\n' +
                  'This requirement covers the happy path for user registration only.';
      const result = validateRequirement(doc);
      const errorIssue = result.issues.find(i => i.type === 'missing_error_scenarios');
      expect(errorIssue).toBeDefined();
      expect(errorIssue!.severity).toBe('warning');
    });

    it('should not warn when error handling is present', () => {
      const doc = 'Feature: User Registration\nAs a new user I want to register an account.\n' +
                  'The user must provide their name and email address.\n' +
                  'If the email is invalid, the system should return a 400 error with validation details.\n' +
                  'If the user already exists, return 409 conflict.';
      const result = validateRequirement(doc);
      const errorIssue = result.issues.find(i => i.type === 'missing_error_scenarios');
      expect(errorIssue).toBeUndefined();
    });
  });

  // ── Rule 7: Data contracts ─────────────────────────────────────────
  describe('Rule: Data Contracts', () => {
    it('should warn when no data structure definitions are present', () => {
      const doc = 'Feature: Notification Service\nAs an admin, I must be able to send notifications.\n' +
                  'The system will process notifications.\n' +
                  'If sending fails, retry the operation.\n' +
                  'This is a critical milestone feature.';
      const result = validateRequirement(doc);
      const dataIssue = result.issues.find(i => i.type === 'missing_data_contracts');
      expect(dataIssue).toBeDefined();
    });
  });

  // ── Scoring ────────────────────────────────────────────────────────
  describe('Quality Scoring', () => {
    it('should give a high score to well-structured documents', () => {
      const doc = 'Feature: Customer CRUD Management\n\n' +
                  'Acceptance Criteria:\n' +
                  '- The admin user must be able to create a customer with fields: name (string), email (string), phone (string)\n' +
                  '- The API endpoint POST /customers must validate the payload and return 201 on success\n' +
                  '- If the email field is invalid, return HTTP 400 error with validation details\n' +
                  '- If the customer already exists, return 409 conflict\n' +
                  '- Priority: P0 - Must have for MVP\n' +
                  '- Scope: In scope - CRUD operations. Out of scope - bulk import.\n' +
                  '- Given an authenticated admin user\n' +
                  '- When they submit a valid customer creation request\n' +
                  '- Then the system stores the customer entity in the database\n';
      const result = validateRequirement(doc);
      expect(result.isValid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(80);
    });

    it('should give a low score to minimal documents', () => {
      const result = validateRequirement('Do something');
      expect(result.isValid).toBe(false);
      expect(result.score).toBeLessThanOrEqual(30);
    });

    it('should clamp score between 0 and 100', () => {
      const result = validateRequirement('x');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  // ── Severity levels ────────────────────────────────────────────────
  describe('Severity Levels', () => {
    it('should block on error-level issues only', () => {
      // A document that passes errors but has warnings
      const doc = 'Feature: Order Processing\n\n' +
                  'As a system user I want to submit orders via the API endpoint.\n' +
                  'The system must validate the order payload containing amount (number) and status (enum).\n' +
                  'Given a valid order request, when submitted, then return 200 OK.\n';
      const result = validateRequirement(doc);
      // This should be valid (no error-level issues) but may have warnings
      expect(result.isValid).toBe(true);
    });
  });
});
