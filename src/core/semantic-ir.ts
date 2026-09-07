/* ==========================================================================
   gherkin-ai-cli - Semantic Intermediate Representation (IR)
   
   The IR is the core data model that bridges Gherkin specifications
   and all downstream generators, validators, and verification engines.
   
   Design principles:
   - Deterministic by default (AST/regex extraction)
   - Optionally enriched via LLM for brownfield projects
   - Every element traceable back to source location
   - Supports constraint levels (must/should/may/must-not/unspecified)
   ========================================================================== */

// ---------------------------------------------------------------------------
// Source Traceability
// ---------------------------------------------------------------------------

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

export interface TraceableElement {
  id: string;
  source: SourceLocation;
  confidence: number;         // 0.0–1.0 (1.0 = deterministic, <1.0 = inferred)
  inferenceSource: 'deterministic' | 'llm' | 'user' | 'constitution';
}

// ---------------------------------------------------------------------------
// Constraint System (must / should / may / must-not / unspecified)
// ---------------------------------------------------------------------------

export type ConstraintLevel = 'must' | 'should' | 'may' | 'must-not' | 'unspecified';

export interface Constraint extends TraceableElement {
  level: ConstraintLevel;
  description: string;
  category: 'architecture' | 'security' | 'business' | 'technology' | 'compliance';
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Domain Actors
// ---------------------------------------------------------------------------

export interface Actor extends TraceableElement {
  name: string;
  role: string;
  permissions: string[];
  scenarios: string[];        // IDs of scenarios this actor participates in
}

// ---------------------------------------------------------------------------
// Commands & Queries (CQRS-aligned)
// ---------------------------------------------------------------------------

export interface Command extends TraceableElement {
  name: string;
  verb: string;               // e.g., 'create', 'cancel', 'update'
  subject: string;            // e.g., 'order', 'user', 'payment'
  inputFields: FieldSpec[];
  preconditions: string[];
  postconditions: string[];
  triggeredBy: string;        // Actor ID
  emittedEvents: string[];    // Event IDs
}

export interface Query extends TraceableElement {
  name: string;
  subject: string;
  outputFields: FieldSpec[];
  filters: string[];
}

// ---------------------------------------------------------------------------
// Field Specifications
// ---------------------------------------------------------------------------

export interface FieldSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'object' | 'array' | 'unknown';
  required: boolean;
  validations: ValidationRule[];
  exampleValues: string[];
  enumValues?: string[];
}

export interface ValidationRule {
  type: 'email' | 'uuid' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'range' | 'custom';
  params?: Record<string, any>;
  source: string;             // Where this validation was inferred from
}

// ---------------------------------------------------------------------------
// Domain Events
// ---------------------------------------------------------------------------

export interface DomainEvent extends TraceableElement {
  name: string;
  eventType: string;
  payload: FieldSpec[];
  triggeredBy: string[];      // Command IDs
}

// ---------------------------------------------------------------------------
// State Machines & Transitions
// ---------------------------------------------------------------------------

export interface StateTransition extends TraceableElement {
  entity: string;
  fromState: string;
  toState: string;
  trigger: string;            // Command or event that causes the transition
  guards: string[];           // Conditions that must be met
}

export interface StateMachine {
  entity: string;
  states: string[];
  initialState: string;
  finalStates: string[];
  transitions: StateTransition[];
}

// ---------------------------------------------------------------------------
// Invariants (Business Rules)
// ---------------------------------------------------------------------------

export interface Invariant extends TraceableElement {
  name: string;
  expression: string;        // Human-readable rule
  entity: string;
  type: 'state' | 'transition' | 'authorization' | 'data' | 'temporal';
}

// ---------------------------------------------------------------------------
// API Contract Hints
// ---------------------------------------------------------------------------

export interface APIEndpointHint extends TraceableElement {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  operationId: string;
  requestFields: FieldSpec[];
  responseFields: FieldSpec[];
  httpCodes: { code: string; description: string }[];
  authRequired: boolean;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface Policy extends TraceableElement {
  name: string;
  type: 'security' | 'authorization' | 'data' | 'architecture' | 'compliance';
  rules: string[];
}

// ---------------------------------------------------------------------------
// Assumptions & Risks
// ---------------------------------------------------------------------------

export interface Assumption extends TraceableElement {
  description: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  requiresValidation: boolean;
}

export interface Risk extends TraceableElement {
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation?: string;
  category: 'security' | 'architecture' | 'business' | 'compliance' | 'performance';
}

// ---------------------------------------------------------------------------
// Scenario Categories
// ---------------------------------------------------------------------------

export type ScenarioCategory =
  | 'happy-path'
  | 'validation'
  | 'authorization'
  | 'error-handling'
  | 'concurrency'
  | 'timeout'
  | 'retry'
  | 'idempotency'
  | 'partial-failure'
  | 'security'
  | 'performance'
  | 'observability'
  | 'recovery'
  | 'edge-case';

export interface EnrichedScenario extends TraceableElement {
  name: string;
  category: ScenarioCategory;
  tags: string[];
  actors: string[];           // Actor IDs involved
  commands: string[];         // Command IDs executed
  queries: string[];          // Query IDs checked
  preconditions: string[];
  actions: string[];
  expectations: string[];
  coveredInvariants: string[]; // Invariant IDs this scenario tests
  missingPaths: ScenarioCategory[]; // What this scenario does NOT cover
}

// ---------------------------------------------------------------------------
// Traceability Map
// ---------------------------------------------------------------------------

export interface TraceabilityLink {
  from: { type: string; id: string };
  to: { type: string; id: string };
  relationship: 'implements' | 'tests' | 'constrains' | 'triggers' | 'depends-on';
}

export interface TraceabilityMap {
  links: TraceabilityLink[];
  coverage: {
    specifiedRequirements: number;
    implementedRequirements: number;
    testedRequirements: number;
    coveragePercent: number;
  };
}

// ---------------------------------------------------------------------------
// The Complete Specification IR
// ---------------------------------------------------------------------------

export interface SpecificationIR {
  // Metadata
  version: string;
  generatedAt: string;
  sourceFile: string;

  // Feature Identity
  featureId: string;
  featureName: string;
  featureDescription: string[];
  tags: string[];

  // Domain Model
  actors: Actor[];
  commands: Command[];
  queries: Query[];
  events: DomainEvent[];
  fields: FieldSpec[];
  
  // Behavior Model
  scenarios: EnrichedScenario[];
  stateMachines: StateMachine[];
  invariants: Invariant[];

  // Contract Hints
  apiEndpoints: APIEndpointHint[];
  
  // Governance
  constraints: Constraint[];
  policies: Policy[];
  assumptions: Assumption[];
  risks: Risk[];

  // Traceability
  traceability: TraceabilityMap;

  // Quality Indicators
  qualityIndicators: {
    scenarioCompleteness: number;   // 0-100
    constraintCoverage: number;     // 0-100
    missingScenarioCategories: ScenarioCategory[];
    ambiguities: string[];
    contradictions: string[];
  };
}

// ---------------------------------------------------------------------------
// IR Builder Options
// ---------------------------------------------------------------------------

export interface IRBuildOptions {
  mode: 'deterministic' | 'hybrid';
  constitutionPath?: string;
  existingCodebase?: string;    // Path to scan for brownfield enrichment
  llmEnrichment?: boolean;
  traceabilityDepth?: 'shallow' | 'deep';
}
