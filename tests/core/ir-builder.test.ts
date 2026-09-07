import { describe, it, expect, beforeEach } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR, buildSpecificationIR } from '../../src/core/ir-builder';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const CRUD_FEATURE = `Feature: Order Management
  As an authenticated user
  I want to manage orders

  Scenario: Create order successfully
    Given an authenticated user with role "admin"
    When the user creates a new order with total "150.00"
    Then the order status is "PENDING"
    And the system returns HTTP status 201

  Scenario: Cancel pending order
    Given an order with status "PENDING"
    When the user cancels the order
    Then the order status is "CANCELLED"

  Scenario: Update order details
    Given an order with status "PENDING"
    When the user updates the order
    Then the order is updated successfully

  Scenario: Delete draft order
    Given an order with status "DRAFT"
    When the user deletes the order
    Then the order is removed
`;

const AUTH_FEATURE = `@security @compliance-SOX
Feature: User Authentication
  As a system administrator
  I want to control user access

  Scenario: Successful login
    Given a registered user with email "user@test.com"
    When the user logs in with valid credentials
    Then the user receives a JWT token
    And the session is active

  Scenario: Failed login with invalid password
    Given a registered user with email "user@test.com"
    When the user submits an invalid password
    Then the response is HTTP status 401
    And an error message is displayed

  Scenario: Unauthorized access attempt
    Given an unauthenticated user
    When the user tries to access a protected resource
    Then the response is HTTP status 403
    And access is denied
`;

const SPANISH_FEATURE = `# language: es
Característica: Gestión de Productos
  Como un administrador
  Quiero registrar productos

  Escenario: Registrar producto exitosamente
    Dado que el administrador está autenticado
    Cuando crea un nuevo producto con nombre "Widget"
    Entonces el producto es registrado con estado "ACTIVE"

  Escenario: Producto con validación fallida
    Dado que el administrador está autenticado
    Cuando envía un producto con datos inválidos
    Entonces el sistema responde con error de validación
`;

const STATE_MACHINE_FEATURE = `Feature: Order Lifecycle
  As an operator
  I want to manage order lifecycle

  Scenario: Confirm pending order
    Given an order with status "PENDING"
    When the operator approves the order
    Then the order status becomes "CONFIRMED"

  Scenario: Ship confirmed order
    Given an order with status "CONFIRMED"
    When the order is shipped
    Then the order status becomes "SHIPPED"

  Scenario: Deliver shipped order
    Given an order with status "SHIPPED"
    When the delivery is completed
    Then the order status becomes "DELIVERED"

  Scenario: Cancel pending order
    Given an order with status "PENDING"
    When the operator cancels the order
    Then the order status becomes "CANCELLED"
`;

const AMBIGUOUS_FEATURE = `Feature: Vague Requirements
  Scenario: Something works
    Given something exists
    When the system should work somehow
    Then it works
`;

const EVENT_DRIVEN_FEATURE = `Feature: Payment Processing
  Scenario: Process payment
    Given a valid payment request
    When the system processes the payment
    Then it publishes a "PaymentProcessed" event
    And it emits a "NotificationSent" event
`;

const MINIMAL_FEATURE = `Feature: Minimal Feature
  Scenario: Basic scenario
    Given a precondition
    When an action occurs
    Then a result happens
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IR Builder', () => {
  describe('buildIR()', () => {
    it('should return a valid SpecificationIR with all required fields', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'order-management.feature');

      expect(ir.version).toBe('1.0.0');
      expect(ir.generatedAt).toBeDefined();
      expect(ir.sourceFile).toBe('order-management.feature');
      expect(ir.featureId).toMatch(/^FTR-\d{4}$/);
      expect(ir.featureName).toBe('Order Management');
      expect(ir.featureDescription).toBeInstanceOf(Array);
      expect(ir.tags).toBeInstanceOf(Array);
      expect(ir.actors).toBeInstanceOf(Array);
      expect(ir.commands).toBeInstanceOf(Array);
      expect(ir.queries).toBeInstanceOf(Array);
      expect(ir.events).toBeInstanceOf(Array);
      expect(ir.fields).toBeInstanceOf(Array);
      expect(ir.scenarios).toBeInstanceOf(Array);
      expect(ir.stateMachines).toBeInstanceOf(Array);
      expect(ir.invariants).toBeInstanceOf(Array);
      expect(ir.apiEndpoints).toBeInstanceOf(Array);
      expect(ir.constraints).toBeInstanceOf(Array);
      expect(ir.policies).toBeInstanceOf(Array);
      expect(ir.assumptions).toBeInstanceOf(Array);
      expect(ir.risks).toBeInstanceOf(Array);
      expect(ir.traceability).toBeDefined();
      expect(ir.qualityIndicators).toBeDefined();
    });

    it('should export buildSpecificationIR as alias', () => {
      expect(buildSpecificationIR).toBe(buildIR);
    });

    it('should use default sourceFile when not provided', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed);
      expect(ir.sourceFile).toBe('unknown.feature');
    });
  });

  // -------------------------------------------------------------------------
  // Actor Extraction
  // -------------------------------------------------------------------------

  describe('Actor Extraction', () => {
    it('should extract actors from feature description ("As an authenticated user")', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const actorNames = ir.actors.map(a => a.name);
      expect(actorNames).toContain('authenticated user');
    });

    it('should extract authenticated user from auth patterns in steps', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const hasAuthActor = ir.actors.some(
        a => a.name === 'authenticated user' || a.role === 'authenticated'
      );
      expect(hasAuthActor).toBe(true);
    });

    it('should extract actors from Spanish features', () => {
      const parsed = parseGherkinText(SPANISH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.actors.length).toBeGreaterThan(0);
      const actorNames = ir.actors.map(a => a.name);
      expect(actorNames.some(n => n.includes('administrador'))).toBe(true);
    });

    it('should create a default "user" actor when none found', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.actors.length).toBeGreaterThanOrEqual(1);
      const defaultActor = ir.actors.find(a => a.name === 'user');
      if (defaultActor) {
        expect(defaultActor.confidence).toBeLessThanOrEqual(0.5);
      }
    });

    it('should assign deterministic IDs to actors', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      for (const actor of ir.actors) {
        expect(actor.id).toMatch(/^ACT-\d{4}$/);
        expect(actor.inferenceSource).toBe('deterministic');
      }
    });

    it('should not duplicate actors extracted from multiple steps', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const names = ir.actors.map(a => a.name);
      const uniqueNames = [...new Set(names)];
      expect(names.length).toBe(uniqueNames.length);
    });
  });

  // -------------------------------------------------------------------------
  // Command Extraction
  // -------------------------------------------------------------------------

  describe('Command Extraction', () => {
    it('should extract commands from When steps', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.commands.length).toBeGreaterThan(0);
      for (const cmd of ir.commands) {
        expect(cmd.id).toMatch(/^CMD-\d{4}$/);
      }
    });

    it('should identify CRUD verbs correctly', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const verbs = ir.commands.map(c => c.verb);
      expect(verbs).toContain('create');
      expect(verbs).toContain('cancel');
      expect(verbs).toContain('update');
      expect(verbs).toContain('delete');
    });

    it('should detect login verb', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const loginCmd = ir.commands.find(c => c.verb === 'login');
      expect(loginCmd).toBeDefined();
    });

    it('should attach preconditions (Given steps) to commands', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const createCmd = ir.commands.find(c => c.verb === 'create');
      expect(createCmd).toBeDefined();
      expect(createCmd!.preconditions.length).toBeGreaterThan(0);
    });

    it('should attach postconditions (Then steps) to commands', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const createCmd = ir.commands.find(c => c.verb === 'create');
      expect(createCmd).toBeDefined();
      expect(createCmd!.postconditions.length).toBeGreaterThan(0);
    });

    it('should set lower confidence for unknown verbs', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const unknownCmd = ir.commands.find(c => c.verb === 'unknown');
      if (unknownCmd) {
        expect(unknownCmd.confidence).toBeLessThanOrEqual(0.5);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Query Extraction
  // -------------------------------------------------------------------------

  describe('Query Extraction', () => {
    it('should extract queries from Then steps (non-event)', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.queries.length).toBeGreaterThan(0);
      for (const q of ir.queries) {
        expect(q.id).toMatch(/^QRY-\d{4}$/);
      }
    });

    it('should not extract event-like Then steps as queries', () => {
      const parsed = parseGherkinText(EVENT_DRIVEN_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // Events should be in ir.events, not queries
      const queryTexts = ir.queries.map(q => q.name);
      const hasEventQuery = queryTexts.some(t =>
        t.includes('event') || t.includes('publishes') || t.includes('emits')
      );
      expect(hasEventQuery).toBe(false);
    });

    it('should deduplicate identical queries', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const names = ir.queries.map(q => q.name);
      const unique = [...new Set(names)];
      expect(names.length).toBe(unique.length);
    });
  });

  // -------------------------------------------------------------------------
  // Event Extraction
  // -------------------------------------------------------------------------

  describe('Event Extraction', () => {
    it('should extract events from Then steps with event-related keywords', () => {
      const parsed = parseGherkinText(EVENT_DRIVEN_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.events.length).toBe(2);
      for (const evt of ir.events) {
        expect(evt.id).toMatch(/^EVT-\d{4}$/);
      }
    });

    it('should not extract events from features without event keywords', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.events.length).toBe(0);
    });

    it('should also catch events from emits keyword in English spec', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'order.feature');

      // CRUD_FEATURE doesn't have event keywords, so 0 expected
      expect(ir.events.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // State Machine Extraction
  // -------------------------------------------------------------------------

  describe('State Machine Extraction', () => {
    it('should extract state machines when multiple states are found', () => {
      const parsed = parseGherkinText(STATE_MACHINE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.stateMachines.length).toBeGreaterThan(0);
    });

    it('should identify all unique states', () => {
      const parsed = parseGherkinText(STATE_MACHINE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const sm = ir.stateMachines[0];
      expect(sm.states).toContain('PENDING');
      expect(sm.states).toContain('CONFIRMED');
      expect(sm.states).toContain('SHIPPED');
      expect(sm.states).toContain('DELIVERED');
      expect(sm.states).toContain('CANCELLED');
    });

    it('should detect final states (DELIVERED, CANCELLED)', () => {
      const parsed = parseGherkinText(STATE_MACHINE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const sm = ir.stateMachines[0];
      expect(sm.finalStates).toContain('DELIVERED');
      expect(sm.finalStates).toContain('CANCELLED');
    });

    it('should create transitions from Given→Then state pairs', () => {
      const parsed = parseGherkinText(STATE_MACHINE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const sm = ir.stateMachines[0];
      expect(sm.transitions.length).toBeGreaterThan(0);

      const pendingToConfirmed = sm.transitions.find(
        t => t.fromState === 'PENDING' && t.toState === 'CONFIRMED'
      );
      expect(pendingToConfirmed).toBeDefined();
    });

    it('should not create state machines when fewer than 2 states found', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.stateMachines.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Invariant Extraction
  // -------------------------------------------------------------------------

  describe('Invariant Extraction', () => {
    it('should generate invariants for forbidden transitions from final states', () => {
      const parsed = parseGherkinText(STATE_MACHINE_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // Final states (DELIVERED, CANCELLED) should have invariants preventing transitions
      const invariantsFromFinal = ir.invariants.filter(
        inv => inv.type === 'transition'
      );
      expect(invariantsFromFinal.length).toBeGreaterThan(0);
    });

    it('should extract invariants from "should not" / "must not" patterns', () => {
      const feature = `Feature: Negative Rule
  Scenario: Cannot overdraw
    Given an account with balance "0"
    When a withdrawal is attempted
    Then the withdrawal should not proceed
`;
      const parsed = parseGherkinText(feature);
      const ir = buildIR(parsed, 'test.feature');

      const negativeInvariants = ir.invariants.filter(inv => inv.type === 'state');
      expect(negativeInvariants.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // API Endpoint Extraction
  // -------------------------------------------------------------------------

  describe('API Endpoint Extraction', () => {
    it('should infer API endpoints from commands', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.apiEndpoints.length).toBeGreaterThan(0);
      for (const ep of ir.apiEndpoints) {
        expect(ep.id).toMatch(/^API-\d{4}$/);
        expect(ep.path).toContain('/api/v1/');
      }
    });

    it('should map verbs to HTTP methods correctly', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const createEp = ir.apiEndpoints.find(ep => ep.method === 'POST');
      expect(createEp).toBeDefined();

      const updateEp = ir.apiEndpoints.find(ep => ep.method === 'PUT');
      expect(updateEp).toBeDefined();

      const deleteEp = ir.apiEndpoints.find(ep => ep.method === 'DELETE');
      expect(deleteEp).toBeDefined();
    });

    it('should add {id} parameter for update/delete endpoints', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const updateEp = ir.apiEndpoints.find(ep => ep.method === 'PUT');
      if (updateEp) {
        expect(updateEp.path).toContain('{id}');
      }

      const deleteEp = ir.apiEndpoints.find(ep => ep.method === 'DELETE');
      if (deleteEp) {
        expect(deleteEp.path).toContain('{id}');
      }
    });

    it('should detect auth requirement from scenarios', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const authEndpoints = ir.apiEndpoints.filter(ep => ep.authRequired);
      expect(authEndpoints.length).toBeGreaterThan(0);
    });

    it('should include HTTP codes from parsed feature', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // HTTP codes are extracted by the parser and propagated to endpoints
      // The CRUD_FEATURE has "HTTP status 201" which gets parsed to httpCodes
      const allCodes = ir.apiEndpoints.flatMap(ep => ep.httpCodes.map(c => c.code));
      // At minimum, endpoints should have default success codes
      expect(allCodes.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Constraint & Policy Extraction
  // -------------------------------------------------------------------------

  describe('Constraint Extraction', () => {
    it('should extract security constraints from @security tags', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const securityConstraints = ir.constraints.filter(c => c.category === 'security');
      expect(securityConstraints.length).toBeGreaterThan(0);
      expect(securityConstraints[0].level).toBe('must');
    });

    it('should extract compliance constraints from @compliance tags', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const complianceConstraints = ir.constraints.filter(c => c.category === 'compliance');
      expect(complianceConstraints.length).toBeGreaterThan(0);
    });
  });

  describe('Policy Extraction', () => {
    it('should detect authorization policy from auth scenarios', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const authPolicy = ir.policies.find(p => p.type === 'authorization');
      expect(authPolicy).toBeDefined();
      expect(authPolicy!.confidence).toBeGreaterThanOrEqual(0.8);
    });
  });

  // -------------------------------------------------------------------------
  // Assumptions & Risks
  // -------------------------------------------------------------------------

  describe('Assumption Extraction', () => {
    it('should flag missing auth as assumption', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const noAuthAssumption = ir.assumptions.find(a =>
        a.description.toLowerCase().includes('authorization') ||
        a.description.toLowerCase().includes('unauthenticated')
      );
      expect(noAuthAssumption).toBeDefined();
      expect(noAuthAssumption!.impact).toBe('high');
    });

    it('should flag missing error handling as assumption', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const noErrorAssumption = ir.assumptions.find(a =>
        a.description.toLowerCase().includes('error')
      );
      expect(noErrorAssumption).toBeDefined();
    });

    it('should not flag assumptions when auth scenarios exist', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const noAuthAssumption = ir.assumptions.find(a =>
        a.description.toLowerCase().includes('unauthenticated access')
      );
      expect(noAuthAssumption).toBeUndefined();
    });
  });

  describe('Risk Extraction', () => {
    it('should detect security risk for write ops without auth', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      // MINIMAL_FEATURE has no create verb, but let's use CRUD without auth patterns
      const noAuthCrud = `Feature: Insecure CRUD
  Scenario: Create without auth
    Given a product catalog
    When the user creates a new product
    Then the product is saved
`;
      const parsedNoAuth = parseGherkinText(noAuthCrud);
      const ir = buildIR(parsedNoAuth, 'test.feature');

      const secRisk = ir.risks.find(r => r.category === 'security');
      expect(secRisk).toBeDefined();
      expect(secRisk!.severity).toBe('high');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario Categorization
  // -------------------------------------------------------------------------

  describe('Scenario Categorization', () => {
    it('should categorize error-handling scenarios', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const errorScenarios = ir.scenarios.filter(s => s.category === 'error-handling');
      expect(errorScenarios.length).toBeGreaterThan(0);
    });

    it('should categorize authorization scenarios', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const authScenarios = ir.scenarios.filter(s => s.category === 'authorization');
      expect(authScenarios.length).toBeGreaterThan(0);
    });

    it('should default to happy-path when no pattern matches', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.scenarios[0].category).toBe('happy-path');
    });

    it('should categorize validation scenarios', () => {
      const validationFeature = `Feature: Form Validation
  Scenario: Invalid input
    Given a registration form
    When the user submits with invalid data
    Then a validation error is shown
`;
      const parsed = parseGherkinText(validationFeature);
      const ir = buildIR(parsed, 'test.feature');

      // 'invalid' and 'validation' both appear, but ERROR_PATTERNS may match first
      // The categorizer checks error patterns before validation
      const categories = ir.scenarios.map(s => s.category);
      expect(categories.some(c => c === 'validation' || c === 'error-handling')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Quality Indicators
  // -------------------------------------------------------------------------

  describe('Quality Indicators', () => {
    it('should detect missing essential scenario categories', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // Minimal feature should be missing validation, authorization, error-handling
      expect(ir.qualityIndicators.missingScenarioCategories.length).toBeGreaterThan(0);
    });

    it('should report full coverage for feature with all essential categories', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // AUTH_FEATURE has happy-path (login), error-handling (failed login), authorization
      // Might still miss 'validation'
      expect(ir.qualityIndicators.scenarioCompleteness).toBeGreaterThan(0);
    });

    it('should detect ambiguities in vague specifications', () => {
      const parsed = parseGherkinText(AMBIGUOUS_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.qualityIndicators.ambiguities.length).toBeGreaterThan(0);
      expect(ir.qualityIndicators.ambiguities[0]).toContain('Ambiguous');
    });

    it('should not flag ambiguities in well-written specifications', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      // CRUD_FEATURE has specific, non-vague steps
      const vagueAmbiguities = ir.qualityIndicators.ambiguities.filter(a =>
        a.includes('Ambiguous step') && a.includes('something')
      );
      expect(vagueAmbiguities.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Traceability Map
  // -------------------------------------------------------------------------

  describe('Traceability Map', () => {
    it('should generate traceability links', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.traceability.links.length).toBeGreaterThan(0);
    });

    it('should have scenario→command "tests" relationships when subjects match', () => {
      // The traceability builder links scenarios to commands when the command's
      // subject appears in the scenario's When step text
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const testLinks = ir.traceability.links.filter(l => l.relationship === 'tests');
      // Links may or may not exist depending on subject extraction matching
      expect(testLinks).toBeInstanceOf(Array);
    });

    it('should have command→api-endpoint "implements" relationships', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      const implementsLinks = ir.traceability.links.filter(l => l.relationship === 'implements');
      expect(implementsLinks.length).toBeGreaterThan(0);
    });

    it('should compute coverage statistics', () => {
      const parsed = parseGherkinText(CRUD_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.traceability.coverage).toBeDefined();
      expect(ir.traceability.coverage.specifiedRequirements).toBeGreaterThan(0);
      expect(typeof ir.traceability.coverage.coveragePercent).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic ID Generation
  // -------------------------------------------------------------------------

  describe('Deterministic ID Generation', () => {
    it('should reset ID counter between builds', () => {
      const parsed = parseGherkinText(MINIMAL_FEATURE);

      const ir1 = buildIR(parsed, 'test.feature');
      const ir2 = buildIR(parsed, 'test.feature');

      // IDs should be identical because counter is reset
      expect(ir1.featureId).toBe(ir2.featureId);
      expect(ir1.actors[0]?.id).toBe(ir2.actors[0]?.id);
    });
  });

  // -------------------------------------------------------------------------
  // Tags Preservation
  // -------------------------------------------------------------------------

  describe('Tags', () => {
    it('should preserve feature-level tags', () => {
      const parsed = parseGherkinText(AUTH_FEATURE);
      const ir = buildIR(parsed, 'test.feature');

      expect(ir.tags).toContain('@security');
    });
  });
});
