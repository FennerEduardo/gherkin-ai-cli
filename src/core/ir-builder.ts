/* ==========================================================================
   gherkin-ai-cli - IR Builder (Gherkin AST → Semantic Intermediate Representation)
   
   Compiles ParsedFeature into a rich SpecificationIR using deterministic
   analysis with optional LLM enrichment for brownfield projects.
   ========================================================================== */

import { ParsedFeature, ScenarioModel, StepModel } from './gherkin-parser';
import {
  SpecificationIR,
  IRBuildOptions,
  Actor,
  Command,
  Query,
  DomainEvent,
  FieldSpec,
  ValidationRule,
  EnrichedScenario,
  ScenarioCategory,
  StateMachine,
  StateTransition,
  Invariant,
  APIEndpointHint,
  Constraint,
  Policy,
  Assumption,
  Risk,
  TraceabilityMap,
  TraceabilityLink,
  SourceLocation
} from './semantic-ir';
import { loadConstitution, Constitution } from './constitution';
import { resolveDomainProfile } from './profiles/profile-registry';

// ---------------------------------------------------------------------------
// Deterministic ID Generator
// ---------------------------------------------------------------------------

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter++;
  return `${prefix}-${String(idCounter).padStart(4, '0')}`;
}

function resetIdCounter(): void {
  idCounter = 0;
}

// ---------------------------------------------------------------------------
// NLP-lite Semantic Extraction Helpers
// ---------------------------------------------------------------------------

const VERB_PATTERNS: Record<string, RegExp> = {
  create: /\b(creates?|registers?|adds?|inserts?|crea|registra|agrega)\b/i,
  update: /\b(updates?|modifies?|edits?|changes?|actualiza|modifica|edita)\b/i,
  delete: /\b(deletes?|removes?|eliminates?|elimina|remueve|borra)\b/i,
  cancel: /\b(cancels?|cancela)\b/i,
  approve: /\b(approves?|accepts?|aprueba|acepta)\b/i,
  reject: /\b(rejects?|denies?|rechaza|niega)\b/i,
  login: /\b(logs?\s*in|authenticat(es?|ion)|sign\s*in|inicia\s*sesión|autentica)\b/i,
  logout: /\b(logs?\s*out|sign\s*out|cierra\s*sesión)\b/i,
  send: /\b(sends?|dispatches?|envía|despacha)\b/i,
  search: /\b(searches?|finds?|queries?|looks?\s*up|busca|encuentra|consulta)\b/i,
  pay: /\b(pays?|charges?|paga|cobra)\b/i,
  calculate: /\b(calculat(es?|ion)|comput(es?|ation)|calcula)\b/i,
  assign: /\b(assigns?|allocat(es?|ion)|asigna)\b/i,
  verify: /\b(verif(ies?|y)|validat(es?|ion)|verifica|valida)\b/i,
  publish: /\b(publishes?|emits?|broadcasts?|publica|emite)\b/i,
  upload: /\b(uploads?|sube|carga)\b/i,
  download: /\b(downloads?|descarga|baja)\b/i,
};

const STATE_PATTERNS: Record<string, RegExp> = {
  PENDING: /\b(pending|pendiente|awaiting|esperando)\b/i,
  ACTIVE: /\b(active|activo|enabled|habilitado)\b/i,
  CONFIRMED: /\b(confirmed|confirmado|approved|aprobado)\b/i,
  CANCELLED: /\b(cancelled|canceled|cancelado)\b/i,
  COMPLETED: /\b(completed|completado|finished|finalizado|done)\b/i,
  SHIPPED: /\b(shipped|enviado|dispatched|despachado)\b/i,
  DELIVERED: /\b(delivered|entregado)\b/i,
  REJECTED: /\b(rejected|rechazado|denied|denegado)\b/i,
  SUSPENDED: /\b(suspended|suspendido|blocked|bloqueado)\b/i,
  DRAFT: /\b(draft|borrador)\b/i,
  PUBLISHED: /\b(published|publicado)\b/i,
  ARCHIVED: /\b(archived|archivado)\b/i,
  FAILED: /\b(failed|fallido|error)\b/i,
  PROCESSING: /\b(processing|procesando|in.?progress|en.?proceso)\b/i,
  PAID: /\b(paid|pagado)\b/i,
};

const ACTOR_PATTERNS = [
  /\b(?:as (?:a|an)|como (?:un|una))\s+(.+)/i,
  /\b(?:the|el|la|un|una)\s+(user|admin|customer|manager|operator|system|agent|usuario|administrador|cliente|gerente|operador|sistema|agente)\b/i,
  /\b(authenticated|authorized|unauthenticated|unauthorized|autenticado|autorizado)\s+(user|usuario)\b/i,
];

const AUTH_PATTERNS = [
  /\b(authenticated|authorized|logged.?in|autenticado|autorizado|con.?sesión)\b/i,
  /\b(has.?permission|tiene.?permiso|has.?role|tiene.?rol|is.?admin|es.?admin)\b/i,
  /\b(token|jwt|session|sesión|cookie|bearer)\b/i,
];

const ERROR_PATTERNS = [
  /\b(error|fail(s|ed|ure)?|invalid|denied|forbidden|not.?found|fallo|inválido|denegado|prohibido|no.?encontrado)\b/i,
  /\b(HTTP\s*(?:status\s*)?(?:4\d{2}|5\d{2}))\b/i,
  /\b(exception|timeout|unavailable|excepción|tiempo.?agotado|no.?disponible)\b/i,
];

// ---------------------------------------------------------------------------
// IR Builder
// ---------------------------------------------------------------------------

export function buildIR(
  parsed: ParsedFeature,
  sourceFile: string = 'unknown.feature',
  options: IRBuildOptions = { mode: 'deterministic' }
): SpecificationIR {
  resetIdCounter();

  const constitution = options.constitutionPath
    ? loadConstitution()
    : null;

  const actors = extractActors(parsed, sourceFile);
  const commands = extractCommands(parsed, sourceFile, actors);
  const queries = extractQueries(parsed, sourceFile);
  const events = extractEvents(parsed, sourceFile, commands);
  const fields = enrichFields(parsed.domainAnalysis.fields.map(f => ({
    name: f.name,
    type: inferFieldType(f.type, f.name),
    required: true,
    validations: extractValidationRules(f.validations),
    exampleValues: [],
    enumValues: undefined,
  })));

  const stateMachines = extractStateMachines(parsed, sourceFile);
  const invariants = extractInvariants(parsed, sourceFile, stateMachines);
  const apiEndpoints = extractAPIEndpoints(parsed, sourceFile, commands, fields);
  const constraints = extractConstraints(parsed, constitution, sourceFile);
  const policies = extractPolicies(parsed, constitution, sourceFile);
  const assumptions = extractAssumptions(parsed, sourceFile);
  const risks = extractRisks(parsed, sourceFile);

  // Automatic Domain Profile Enrichment (Option 2)
  const activeProfileName = options.profileName || options.domainProfile;
  const profile = resolveDomainProfile(activeProfileName);
  if (profile) {
    profile.commonEvents.forEach(pe => {
      if (!events.some(e => e.name.toLowerCase() === pe.name.toLowerCase())) {
        events.push({
          id: generateId('EVT'),
          name: pe.name,
          eventType: pe.name,
          payload: [],
          triggeredBy: commands.length > 0 ? [commands[0].id] : [],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'deterministic'
        });
      }
    });

    profile.commonCommands.forEach(pc => {
      if (!commands.some(c => c.name.toLowerCase() === pc.name.toLowerCase())) {
        commands.push({
          id: generateId('CMD'),
          name: pc.name,
          verb: pc.name.replace(/Payment$/, '').toLowerCase(),
          subject: 'payment',
          inputFields: [],
          preconditions: [],
          postconditions: [],
          triggeredBy: actors[0]?.id || 'ACT-0001',
          emittedEvents: [],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'deterministic'
        });
      }
    });

    if (profile.stateMachines) {
      for (const [smName, states] of Object.entries(profile.stateMachines)) {
        if (!stateMachines.some(sm => sm.entity === smName)) {
          stateMachines.push({
            entity: smName,
            states: states.map(s => s.name),
            initialState: states[0]?.name || 'Pending',
            finalStates: states.filter(s => s.transitions.length === 0).map(s => s.name),
            transitions: states.flatMap(s => s.transitions.map(t => ({
              id: generateId('TRN'),
              entity: smName,
              fromState: s.name,
              toState: t,
              trigger: `On${t}`,
              guards: [],
              source: { file: sourceFile, line: 0 },
              confidence: 1.0,
              inferenceSource: 'deterministic'
            })))
          });
        }
      }
    }

    profile.getStandardRules().forEach(rule => {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Profile Requirement: ${rule}`,
        category: 'compliance',
        evidence: [profile.id],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic'
      });
    });

    policies.push({
      id: generateId('POL'),
      name: `${profile.name} Governance Policy`,
      type: 'security',
      rules: [
        `Domain Profile: ${profile.name} (${profile.id})`,
        `Mandatory Rules: ${profile.getStandardRules().join(', ')}`
      ],
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'deterministic'
    });
  }

  const enrichedScenarios = enrichScenarios(
    parsed.scenarios, sourceFile, actors, commands, queries
  );

  const missingCategories = detectMissingScenarioCategories(enrichedScenarios);
  const ambiguities = detectAmbiguities(parsed);
  const contradictions = detectContradictions(enrichedScenarios, invariants);

  const traceability = buildTraceabilityMap(
    enrichedScenarios, commands, queries, events, invariants, apiEndpoints
  );

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    sourceFile,

    featureId: generateId('FTR'),
    featureName: parsed.featureName,
    featureDescription: parsed.descriptionLines,
    tags: parsed.tags,

    actors,
    commands,
    queries,
    events,
    fields,

    scenarios: enrichedScenarios,
    stateMachines,
    invariants,

    apiEndpoints,

    constraints,
    policies,
    assumptions,
    risks,

    traceability,

    qualityIndicators: {
      scenarioCompleteness: calculateScenarioCompleteness(enrichedScenarios, missingCategories),
      constraintCoverage: calculateConstraintCoverage(constraints, enrichedScenarios),
      missingScenarioCategories: missingCategories,
      ambiguities,
      contradictions,
    },
  };
}

export const buildSpecificationIR = buildIR;

// ---------------------------------------------------------------------------
// Actor Extraction
// ---------------------------------------------------------------------------

function extractActors(parsed: ParsedFeature, sourceFile: string): Actor[] {
  const actorMap = new Map<string, Actor>();

  // From feature description
  for (const line of parsed.descriptionLines) {
    for (const pattern of ACTOR_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const name = match[1].trim().toLowerCase();
        if (!actorMap.has(name)) {
          actorMap.set(name, {
            id: generateId('ACT'),
            name,
            role: name,
            permissions: [],
            scenarios: [],
            source: { file: sourceFile, line: 0 },
            confidence: 1.0,
            inferenceSource: 'deterministic',
          });
        }
      }
    }
  }

  // From scenarios (Given steps often mention actors)
  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      for (const pattern of ACTOR_PATTERNS) {
        const match = step.text.match(pattern);
        if (match) {
          const name = match[1].trim().toLowerCase();
          if (!actorMap.has(name)) {
            actorMap.set(name, {
              id: generateId('ACT'),
              name,
              role: name,
              permissions: [],
              scenarios: [],
              source: { file: sourceFile, line: 0 },
              confidence: 0.9,
              inferenceSource: 'deterministic',
            });
          }
        }
      }

      // Detect auth-related actors
      if (AUTH_PATTERNS.some(p => p.test(step.text))) {
        const actorName = 'authenticated user';
        if (!actorMap.has(actorName)) {
          actorMap.set(actorName, {
            id: generateId('ACT'),
            name: actorName,
            role: 'authenticated',
            permissions: ['login'],
            scenarios: [],
            source: { file: sourceFile, line: 0 },
            confidence: 0.85,
            inferenceSource: 'deterministic',
          });
        }
      }
    }
  }

  // If no actors found, create a default
  if (actorMap.size === 0) {
    actorMap.set('user', {
      id: generateId('ACT'),
      name: 'user',
      role: 'default',
      permissions: [],
      scenarios: [],
      source: { file: sourceFile, line: 0 },
      confidence: 0.5,
      inferenceSource: 'deterministic',
    });
  }

  return Array.from(actorMap.values());
}

// ---------------------------------------------------------------------------
// Command Extraction
// ---------------------------------------------------------------------------

function extractCommands(
  parsed: ParsedFeature,
  sourceFile: string,
  actors: Actor[]
): Command[] {
  const commands: Command[] = [];
  const defaultActorId = actors[0]?.id || 'ACT-0001';

  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      if (step.keyword !== 'When') continue;

      let verb = 'unknown';
      let subject = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_');

      for (const [v, pattern] of Object.entries(VERB_PATTERNS)) {
        if (pattern.test(step.text)) {
          verb = v;
          break;
        }
      }

      // Try to extract subject from step text
      const subjectMatch = step.text.match(/(?:the|an?|el|la|un|una)\s+(\w+(?:\s+\w+)?)/i);
      if (subjectMatch) {
        subject = subjectMatch[1].toLowerCase().replace(/\s+/g, '_');
      }

      const preconditions = sc.steps
        .filter(s => s.keyword === 'Given')
        .map(s => s.text);

      const postconditions = sc.steps
        .filter(s => s.keyword === 'Then')
        .map(s => s.text);

      // Detect emitted events from Then steps
      const emittedEventIds: string[] = [];

      commands.push({
        id: generateId('CMD'),
        name: `${verb}_${subject}`,
        verb,
        subject,
        inputFields: [],
        preconditions,
        postconditions,
        triggeredBy: defaultActorId,
        emittedEvents: emittedEventIds,
        source: { file: sourceFile, line: 0 },
        confidence: verb === 'unknown' ? 0.5 : 0.9,
        inferenceSource: 'deterministic',
      });
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Query Extraction
// ---------------------------------------------------------------------------

function extractQueries(parsed: ParsedFeature, sourceFile: string): Query[] {
  const queries: Query[] = [];
  const seenQueries = new Set<string>();

  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      if (step.keyword !== 'Then') continue;
      // Skip event-like Then steps
      if (/event|publishes|emits|broadcasts|evento|emite/i.test(step.text)) continue;

      const queryText = step.text.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 50);
      if (seenQueries.has(queryText)) continue;
      seenQueries.add(queryText);

      queries.push({
        id: generateId('QRY'),
        name: queryText,
        subject: parsed.featureName.toLowerCase(),
        outputFields: [],
        filters: [],
        source: { file: sourceFile, line: 0 },
        confidence: 0.7,
        inferenceSource: 'deterministic',
      });
    }
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Event Extraction
// ---------------------------------------------------------------------------

function extractEvents(
  parsed: ParsedFeature,
  sourceFile: string,
  commands: Command[]
): DomainEvent[] {
  const events: DomainEvent[] = [];

  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      if (!/event|publishes|emits|broadcasts|evento|emite/i.test(step.text)) continue;

      const eventName = step.text.replace(/[^a-zA-Z0-9]/g, '').substring(0, 60);
      events.push({
        id: generateId('EVT'),
        name: eventName,
        eventType: eventName,
        payload: [],
        triggeredBy: commands.length > 0 ? [commands[0].id] : [],
        source: { file: sourceFile, line: 0 },
        confidence: 0.8,
        inferenceSource: 'deterministic',
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// State Machine Extraction
// ---------------------------------------------------------------------------

function extractStateMachines(parsed: ParsedFeature, sourceFile: string): StateMachine[] {
  const statesByEntity = new Map<string, Set<string>>();
  const transitions: StateTransition[] = [];

  // Scan all steps for state-related words
  const allStates: string[] = [];
  const entityName = parsed.featureName.replace(/[^a-zA-Z]/g, '');

  for (const sc of parsed.scenarios) {
    const stepsText = sc.steps.map(s => s.text).join(' ');
    const scenarioStates: string[] = [];

    for (const [state, pattern] of Object.entries(STATE_PATTERNS)) {
      if (pattern.test(stepsText)) {
        scenarioStates.push(state);
        allStates.push(state);
      }
    }

    // Also extract from quoted values like status "PENDING"
    const quotedStates = stepsText.match(/(?:status|estado|state)\s*"([^"]+)"/gi);
    if (quotedStates) {
      for (const qs of quotedStates) {
        const match = qs.match(/"([^"]+)"/);
        if (match) {
          const state = match[1].toUpperCase();
          scenarioStates.push(state);
          allStates.push(state);
        }
      }
    }

    // Detect transitions within a scenario (Given state → Then state)
    if (scenarioStates.length >= 2) {
      const givenStates: string[] = [];
      const thenStates: string[] = [];

      for (const step of sc.steps) {
        for (const [state, pattern] of Object.entries(STATE_PATTERNS)) {
          if (pattern.test(step.text)) {
            if (step.keyword === 'Given') givenStates.push(state);
            if (step.keyword === 'Then') thenStates.push(state);
          }
        }
        // Check quoted states
        const qMatch = step.text.match(/(?:status|estado|state)\s*"([^"]+)"/i);
        if (qMatch) {
          const state = qMatch[1].toUpperCase();
          if (step.keyword === 'Given') givenStates.push(state);
          if (step.keyword === 'Then') thenStates.push(state);
        }
      }

      for (const from of givenStates) {
        for (const to of thenStates) {
          if (from !== to) {
            transitions.push({
              id: generateId('TRN'),
              entity: entityName,
              fromState: from,
              toState: to,
              trigger: sc.name,
              guards: sc.steps.filter(s => s.keyword === 'Given').map(s => s.text),
              source: { file: sourceFile, line: 0 },
              confidence: 0.85,
              inferenceSource: 'deterministic',
            });
          }
        }
      }
    }
  }

  const uniqueStates = [...new Set(allStates)];
  if (uniqueStates.length < 2) return [];

  return [{
    entity: entityName,
    states: uniqueStates,
    initialState: uniqueStates[0],
    finalStates: uniqueStates.filter(s =>
      ['COMPLETED', 'CANCELLED', 'DELIVERED', 'ARCHIVED', 'FAILED', 'REJECTED'].includes(s)
    ),
    transitions,
  }];
}

// ---------------------------------------------------------------------------
// Invariant Extraction
// ---------------------------------------------------------------------------

function extractInvariants(
  parsed: ParsedFeature,
  sourceFile: string,
  stateMachines: StateMachine[]
): Invariant[] {
  const invariants: Invariant[] = [];

  // Generate invariants from state machine transitions (forbidden transitions)
  for (const sm of stateMachines) {
    const allowedTransitions = new Set(
      sm.transitions.map(t => `${t.fromState}→${t.toState}`)
    );

    for (const from of sm.states) {
      for (const to of sm.states) {
        if (from === to) continue;
        const key = `${from}→${to}`;
        if (!allowedTransitions.has(key)) {
          if (sm.finalStates.includes(from)) {
            invariants.push({
              id: generateId('INV'),
              name: `${sm.entity} cannot transition from ${from} to ${to}`,
              expression: `state(${sm.entity}) == ${from} => CANNOT transition to ${to}`,
              entity: sm.entity,
              type: 'transition',
              source: { file: sourceFile, line: 0 },
              confidence: 0.7,
              inferenceSource: 'deterministic',
            });
          }
        }
      }
    }
  }

  // Extract invariants from Then steps with "should not" / "must not" patterns
  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      if (step.keyword !== 'Then' && step.keyword !== 'And') continue;
      if (/\b(should\s+not|must\s+not|cannot|no\s+debe|no\s+puede)\b/i.test(step.text)) {
        invariants.push({
          id: generateId('INV'),
          name: step.text.substring(0, 80),
          expression: step.text,
          entity: parsed.featureName.replace(/[^a-zA-Z]/g, ''),
          type: 'state',
          source: { file: sourceFile, line: 0 },
          confidence: 0.9,
          inferenceSource: 'deterministic',
        });
      }
    }
  }

  return invariants;
}

// ---------------------------------------------------------------------------
// API Endpoint Extraction
// ---------------------------------------------------------------------------

function extractAPIEndpoints(
  parsed: ParsedFeature,
  sourceFile: string,
  commands: Command[],
  fields: FieldSpec[]
): APIEndpointHint[] {
  const endpoints: APIEndpointHint[] = [];
  const featureSlug = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Infer main CRUD endpoints from commands
  const verbMethodMap: Record<string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'> = {
    create: 'POST',
    update: 'PUT',
    delete: 'DELETE',
    cancel: 'POST',
    approve: 'POST',
    reject: 'POST',
    login: 'POST',
    logout: 'POST',
    search: 'GET',
    calculate: 'POST',
    send: 'POST',
    pay: 'POST',
    verify: 'POST',
    assign: 'POST',
    upload: 'POST',
    download: 'GET',
  };

  const seenPaths = new Set<string>();

  for (const cmd of commands) {
    const method = verbMethodMap[cmd.verb] || 'POST';
    let path = `/api/v1/${featureSlug}`;
    if (['cancel', 'approve', 'reject', 'verify'].includes(cmd.verb)) {
      path += `/{id}/${cmd.verb}`;
    } else if (['update', 'delete'].includes(cmd.verb)) {
      path += '/{id}';
    }

    const pathKey = `${method}:${path}`;
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);

    const httpCodes: { code: string; description: string }[] = [];
    for (const code of parsed.domainAnalysis.httpCodes) {
      const desc = code.startsWith('2') ? 'Success' :
                   code.startsWith('4') ? (code === '401' ? 'Unauthorized' : code === '403' ? 'Forbidden' : code === '404' ? 'Not Found' : 'Client Error') :
                   'Server Error';
      httpCodes.push({ code, description: desc });
    }

    if (httpCodes.length === 0) {
      httpCodes.push({ code: method === 'POST' ? '201' : '200', description: 'Success' });
    }

    const hasAuth = parsed.scenarios.some(sc =>
      sc.steps.some(s => AUTH_PATTERNS.some(p => p.test(s.text)))
    );

    endpoints.push({
      id: generateId('API'),
      method,
      path,
      operationId: `${cmd.verb}${parsed.featureName.replace(/[^a-zA-Z]/g, '')}`,
      requestFields: method !== 'GET' ? fields : [],
      responseFields: fields,
      httpCodes,
      authRequired: hasAuth,
      source: { file: sourceFile, line: 0 },
      confidence: 0.75,
      inferenceSource: 'deterministic',
    });
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Constraint Extraction
// ---------------------------------------------------------------------------

function extractConstraints(
  parsed: ParsedFeature,
  constitution: Constitution | null,
  sourceFile: string
): Constraint[] {
  const constraints: Constraint[] = [];

  // From constitution
  if (constitution) {
    if (constitution.architecture?.required) {
      for (const req of constitution.architecture.required) {
        constraints.push({
          id: generateId('CST'),
          level: 'must',
          description: req,
          category: 'architecture',
          evidence: ['constitution.yaml'],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'constitution',
        });
      }
    }
    if (constitution.architecture?.forbidden) {
      for (const fb of constitution.architecture.forbidden) {
        constraints.push({
          id: generateId('CST'),
          level: 'must-not',
          description: fb,
          category: 'architecture',
          evidence: ['constitution.yaml'],
          source: { file: sourceFile, line: 0 },
          confidence: 1.0,
          inferenceSource: 'constitution',
        });
      }
    }
  }

  // From tags
  for (const tag of parsed.tags) {
    if (tag.startsWith('@security') || tag.startsWith('@seguridad')) {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Security requirement: ${tag}`,
        category: 'security',
        evidence: [tag],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic',
      });
    }
    if (tag.startsWith('@compliance') || tag.startsWith('@cumplimiento')) {
      constraints.push({
        id: generateId('CST'),
        level: 'must',
        description: `Compliance requirement: ${tag}`,
        category: 'compliance',
        evidence: [tag],
        source: { file: sourceFile, line: 0 },
        confidence: 1.0,
        inferenceSource: 'deterministic',
      });
    }
  }

  return constraints;
}

// ---------------------------------------------------------------------------
// Policy Extraction
// ---------------------------------------------------------------------------

function extractPolicies(
  parsed: ParsedFeature,
  constitution: Constitution | null,
  sourceFile: string
): Policy[] {
  const policies: Policy[] = [];

  if (constitution?.security) {
    policies.push({
      id: generateId('POL'),
      name: 'Security Policy',
      type: 'security',
      rules: [
        `Data classification: ${constitution.security.dataClassification}`,
        `Auth provider: ${constitution.security.authProvider}`,
        constitution.security.secretsPolicy,
      ].filter(Boolean),
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'constitution',
    });
  }

  // Detect authorization policies from scenarios
  const hasAuthScenarios = parsed.scenarios.some(sc =>
    sc.steps.some(s => AUTH_PATTERNS.some(p => p.test(s.text)))
  );

  if (hasAuthScenarios) {
    policies.push({
      id: generateId('POL'),
      name: 'Authorization Policy',
      type: 'authorization',
      rules: ['Authentication required for this feature'],
      source: { file: sourceFile, line: 0 },
      confidence: 0.85,
      inferenceSource: 'deterministic',
    });
  }

  return policies;
}

// ---------------------------------------------------------------------------
// Scenario Enrichment
// ---------------------------------------------------------------------------

function enrichScenarios(
  scenarios: ScenarioModel[],
  sourceFile: string,
  actors: Actor[],
  commands: Command[],
  queries: Query[]
): EnrichedScenario[] {
  return scenarios.map(sc => {
    const category = categorizeScenario(sc);
    const actorIds = actors
      .filter(a => sc.steps.some(s => s.text.toLowerCase().includes(a.name)))
      .map(a => a.id);

    const cmdIds = commands
      .filter(c => sc.steps.some(s => s.keyword === 'When' && s.text.toLowerCase().includes(c.subject)))
      .map(c => c.id);

    const qryIds = queries
      .filter(q => sc.steps.some(s => s.keyword === 'Then'))
      .map(q => q.id);

    return {
      id: generateId('SCN'),
      name: sc.name,
      category,
      tags: sc.tags,
      actors: actorIds.length > 0 ? actorIds : (actors[0] ? [actors[0].id] : []),
      commands: cmdIds,
      queries: qryIds,
      preconditions: sc.steps.filter(s => s.keyword === 'Given').map(s => s.text),
      actions: sc.steps.filter(s => s.keyword === 'When').map(s => s.text),
      expectations: sc.steps.filter(s => s.keyword === 'Then').map(s => s.text),
      coveredInvariants: [],
      missingPaths: [],
      source: { file: sourceFile, line: 0 },
      confidence: 1.0,
      inferenceSource: 'deterministic' as const,
    };
  });
}

function categorizeScenario(sc: ScenarioModel): ScenarioCategory {
  const allText = sc.steps.map(s => s.text).join(' ');
  const tags = sc.tags.join(' ');
  const combined = `${allText} ${tags} ${sc.name}`;

  if (ERROR_PATTERNS.some(p => p.test(combined))) return 'error-handling';
  if (AUTH_PATTERNS.some(p => p.test(combined))) return 'authorization';
  if (/\b(security|seguridad|vulnerability|vulnerabilidad)\b/i.test(combined)) return 'security';
  if (/\b(timeout|time.?out|tiempo.?agotado)\b/i.test(combined)) return 'timeout';
  if (/\b(retry|reinten(to|tar))\b/i.test(combined)) return 'retry';
  if (/\b(idempoten(t|cy|ce))\b/i.test(combined)) return 'idempotency';
  if (/\b(concurrent|concurren(cia|te)|parallel|paralel(o|a))\b/i.test(combined)) return 'concurrency';
  if (/\b(partial|parcial)\b/i.test(combined)) return 'partial-failure';
  if (/\b(recover|recuper(ar|ación)|rollback)\b/i.test(combined)) return 'recovery';
  if (/\b(performance|rendimiento|load|carga)\b/i.test(combined)) return 'performance';
  if (/\b(observ|monitor|log|metric|métrica)\b/i.test(combined)) return 'observability';
  if (/\b(edge|edge.?case|borde|límite)\b/i.test(combined)) return 'edge-case';
  if (/\b(valid(ation|ar)|invalid|inválid)\b/i.test(combined)) return 'validation';

  return 'happy-path';
}

// ---------------------------------------------------------------------------
// Quality Analysis
// ---------------------------------------------------------------------------

function detectMissingScenarioCategories(scenarios: EnrichedScenario[]): ScenarioCategory[] {
  const covered = new Set(scenarios.map(s => s.category));
  const essential: ScenarioCategory[] = [
    'happy-path',
    'validation',
    'authorization',
    'error-handling',
  ];
  return essential.filter(c => !covered.has(c));
}

function detectAmbiguities(parsed: ParsedFeature): string[] {
  const ambiguities: string[] = [];
  
  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      // Detect vague language
      if (/\b(something|somehow|somewhere|algo|algún|de alguna manera)\b/i.test(step.text)) {
        ambiguities.push(`Ambiguous step in "${sc.name}": "${step.text}"`);
      }
      // Detect overly generic steps
      if (/\b(the system (should |must )?(work|function|operate))\b/i.test(step.text)) {
        ambiguities.push(`Vague expectation in "${sc.name}": "${step.text}"`);
      }
      // Detect missing specifics
      if (step.keyword === 'Then' && step.text.length < 20) {
        ambiguities.push(`Possibly incomplete assertion in "${sc.name}": "${step.text}"`);
      }
    }
  }

  return ambiguities;
}

function detectContradictions(
  scenarios: EnrichedScenario[],
  invariants: Invariant[]
): string[] {
  const contradictions: string[] = [];

  // Check if any scenario's postconditions violate an invariant
  for (const sc of scenarios) {
    for (const inv of invariants) {
      if (inv.type === 'transition') {
        // Check if scenario attempts a forbidden transition
        for (const expectation of sc.expectations) {
          if (expectation.toLowerCase().includes(inv.entity.toLowerCase())) {
            // Simple heuristic: if the invariant says "cannot transition from X to Y"
            // and the scenario expects that transition
            const transMatch = inv.expression.match(/(\w+)\s*=>\s*CANNOT transition to\s*(\w+)/i);
            if (transMatch) {
              const [, fromState, toState] = transMatch;
              if (
                sc.preconditions.some(p => p.toLowerCase().includes(fromState.toLowerCase())) &&
                expectation.toLowerCase().includes(toState.toLowerCase())
              ) {
                contradictions.push(
                  `Scenario "${sc.name}" contradicts invariant "${inv.name}": ` +
                  `attempts ${fromState}→${toState} transition`
                );
              }
            }
          }
        }
      }
    }
  }

  return contradictions;
}

function calculateScenarioCompleteness(
  scenarios: EnrichedScenario[],
  missingCategories: ScenarioCategory[]
): number {
  if (scenarios.length === 0) return 0;
  const essential = 4; // happy-path, validation, authorization, error-handling
  const covered = essential - missingCategories.length;
  return Math.round((covered / essential) * 100);
}

function calculateConstraintCoverage(
  constraints: Constraint[],
  scenarios: EnrichedScenario[]
): number {
  if (constraints.length === 0) return 100;
  // Simple heuristic: each constraint covered if at least one scenario references it
  let covered = 0;
  for (const c of constraints) {
    const isCovered = scenarios.some(sc =>
      sc.expectations.some(e => e.toLowerCase().includes(c.description.toLowerCase().substring(0, 30)))
    );
    if (isCovered) covered++;
  }
  return Math.round((covered / constraints.length) * 100);
}

// ---------------------------------------------------------------------------
// Traceability Map Builder
// ---------------------------------------------------------------------------

function buildTraceabilityMap(
  scenarios: EnrichedScenario[],
  commands: Command[],
  queries: Query[],
  events: DomainEvent[],
  invariants: Invariant[],
  endpoints: APIEndpointHint[]
): TraceabilityMap {
  const links: TraceabilityLink[] = [];

  // Scenarios → Commands
  for (const sc of scenarios) {
    for (const cmdId of sc.commands) {
      links.push({
        from: { type: 'scenario', id: sc.id },
        to: { type: 'command', id: cmdId },
        relationship: 'tests',
      });
    }
  }

  // Commands → Events
  for (const cmd of commands) {
    for (const evtId of cmd.emittedEvents) {
      links.push({
        from: { type: 'command', id: cmd.id },
        to: { type: 'event', id: evtId },
        relationship: 'triggers',
      });
    }
  }

  // Commands → API Endpoints
  for (const ep of endpoints) {
    const relatedCmd = commands.find(c =>
      ep.operationId.toLowerCase().includes(c.verb)
    );
    if (relatedCmd) {
      links.push({
        from: { type: 'command', id: relatedCmd.id },
        to: { type: 'api-endpoint', id: ep.id },
        relationship: 'implements',
      });
    }
  }

  const total = commands.length + queries.length + events.length;
  const tested = new Set(scenarios.flatMap(s => [...s.commands, ...s.queries])).size;

  return {
    links,
    coverage: {
      specifiedRequirements: total,
      implementedRequirements: 0, // Will be filled by convergence engine
      testedRequirements: tested,
      coveragePercent: total > 0 ? Math.round((tested / total) * 100) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Field Helpers
// ---------------------------------------------------------------------------

function inferFieldType(
  currentType: string,
  name: string
): FieldSpec['type'] {
  if (currentType === 'number') return 'number';
  if (/email/i.test(name)) return 'string';
  if (/date|created_at|updated_at|timestamp|fecha/i.test(name)) return 'date';
  if (/id|uuid/i.test(name)) return 'string';
  if (/price|amount|total|cost|peso|monto|precio/i.test(name)) return 'number';
  if (/count|quantity|cantidad|numero|number/i.test(name)) return 'number';
  if (/is_|has_|active|enabled|visible/i.test(name)) return 'boolean';
  if (/status|estado|type|tipo|role|rol/i.test(name)) return 'enum';
  return 'string';
}

function extractValidationRules(validations: string[]): ValidationRule[] {
  const rules: ValidationRule[] = [];

  for (const v of validations) {
    if (v === '@validate:email') {
      rules.push({ type: 'email', source: v });
    }
    if (v === '@validate:uuid') {
      rules.push({ type: 'uuid', source: v });
    }
    const rangeMatch = v.match(/@range\((\d+),(\d+)\)/);
    if (rangeMatch) {
      rules.push({
        type: 'range',
        params: { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) },
        source: v,
      });
    }
    const minMatch = v.match(/@min\((\d+)\)/);
    if (minMatch) {
      rules.push({ type: 'min', params: { value: parseInt(minMatch[1]) }, source: v });
    }
    const maxMatch = v.match(/@max\((\d+)\)/);
    if (maxMatch) {
      rules.push({ type: 'max', params: { value: parseInt(maxMatch[1]) }, source: v });
    }
    const minLenMatch = v.match(/@minLength\((\d+)\)/);
    if (minLenMatch) {
      rules.push({ type: 'minLength', params: { value: parseInt(minLenMatch[1]) }, source: v });
    }
    const maxLenMatch = v.match(/@maxLength\((\d+)\)/);
    if (maxLenMatch) {
      rules.push({ type: 'maxLength', params: { value: parseInt(maxLenMatch[1]) }, source: v });
    }
    const patternMatch = v.match(/@pattern\((.+)\)/);
    if (patternMatch) {
      rules.push({ type: 'pattern', params: { regex: patternMatch[1] }, source: v });
    }
  }

  return rules;
}

function enrichFields(fields: FieldSpec[]): FieldSpec[] {
  // Add inferred validations based on field names
  for (const field of fields) {
    if (/email/i.test(field.name) && !field.validations.some(v => v.type === 'email')) {
      field.validations.push({ type: 'email', source: 'field-name-inference' });
    }
    if (/uuid|id$/i.test(field.name) && !field.validations.some(v => v.type === 'uuid')) {
      field.validations.push({ type: 'uuid', source: 'field-name-inference' });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Risk & Assumption Extraction
// ---------------------------------------------------------------------------

function extractAssumptions(parsed: ParsedFeature, sourceFile: string): Assumption[] {
  const assumptions: Assumption[] = [];

  // If no auth scenarios, that's an assumption
  const hasAuth = parsed.scenarios.some(sc =>
    sc.steps.some(s => AUTH_PATTERNS.some(p => p.test(s.text)))
  );
  if (!hasAuth) {
    assumptions.push({
      id: generateId('ASM'),
      description: 'No authorization scenarios defined — assumes public/unauthenticated access.',
      impact: 'high',
      requiresValidation: true,
      source: { file: sourceFile, line: 0 },
      confidence: 0.9,
      inferenceSource: 'deterministic',
    });
  }

  // If no error scenarios
  const hasErrors = parsed.scenarios.some(sc =>
    sc.steps.some(s => ERROR_PATTERNS.some(p => p.test(s.text)))
  );
  if (!hasErrors) {
    assumptions.push({
      id: generateId('ASM'),
      description: 'No error-handling scenarios defined — assumes all operations succeed.',
      impact: 'medium',
      requiresValidation: true,
      source: { file: sourceFile, line: 0 },
      confidence: 0.9,
      inferenceSource: 'deterministic',
    });
  }

  return assumptions;
}

function extractRisks(parsed: ParsedFeature, sourceFile: string): Risk[] {
  const risks: Risk[] = [];

  // Security risk if no authentication but writing data
  const hasWriteCommands = parsed.scenarios.some(sc =>
    sc.steps.some(s => s.keyword === 'When' && VERB_PATTERNS.create.test(s.text))
  );
  const hasAuth = parsed.scenarios.some(sc =>
    sc.steps.some(s => AUTH_PATTERNS.some(p => p.test(s.text)))
  );

  if (hasWriteCommands && !hasAuth) {
    risks.push({
      id: generateId('RSK'),
      description: 'Write operations without authentication scenarios. Possible unauthorized access.',
      severity: 'high',
      category: 'security',
      mitigation: 'Add authorization scenarios and/or define auth policy in constitution.yaml.',
      source: { file: sourceFile, line: 0 },
      confidence: 0.85,
      inferenceSource: 'deterministic',
    });
  }

  return risks;
}
