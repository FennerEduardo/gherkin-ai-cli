/* ==========================================================================
   gherkin-ai-cli - IR builder: Actors, commands, queries, events, state machines, invariants and API hints
   ========================================================================== */

import { ParsedFeature } from '../parsers/specification-interface';
import {
  Actor,
  Command,
  Query,
  DomainEvent,
  FieldSpec,
  StateMachine,
  StateTransition,
  Invariant,
  APIEndpointHint
} from '../semantic-ir';
import { declaredTagValues, featurePascalName, toKebab, toSnake } from '../../utils/naming';
import { withoutQuotedText } from '../../utils/quoted-text';
import path from 'path';
import { generateId, VERB_PATTERNS, STATE_PATTERNS, ACTOR_PATTERNS, AUTH_PATTERNS } from './patterns';

// ---------------------------------------------------------------------------
// Actor Extraction
// ---------------------------------------------------------------------------

export function extractActors(parsed: ParsedFeature, sourceFile: string): Actor[] {
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

/** Words that end a noun phrase ("the course for spring" -> "course"). */
export const PHRASE_BOUNDARIES = new Set(['for', 'in', 'on', 'at', 'of', 'by', 'as', 'and', 'or', 'into', 'onto', 'via', 'using', 'without', 'within', 'per', 'para', 'por', 'con', 'sin', 'del', 'de', 'en', 'y', 'o']);

export function extractCommands(
  parsed: ParsedFeature,
  sourceFile: string,
  actors: Actor[]
): Command[] {
  const commands: Command[] = [];
  const defaultActorId = actors[0]?.id || 'ACT-0001';

  // Explicit @command:Name tags replace the inference (any dialect): verb = first word of the name.
  const declared = declaredTagValues(parsed, 'command');
  if (declared.length) {
    return declared.map(name => {
      const words = toSnake(name).split('_').filter(Boolean);
      const verb = words[0] ?? 'process';
      const subject = words.slice(1).join('_') || toSnake(featurePascalName(parsed));
      return {
        id: generateId('CMD'),
        name: `${verb}_${subject}`,
        verb,
        subject,
        inputFields: [],
        preconditions: [],
        postconditions: [],
        triggeredBy: defaultActorId,
        emittedEvents: [],
        source: { file: sourceFile, line: 0 },
        confidence: 1,
        inferenceSource: 'user',
      };
    });
  }

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
      // Skip stop words
      const stopWords = new Set(['a', 'an', 'the', 'el', 'la', 'un', 'una', 'is', 'to', 'from', 'with']);
      // The subject is a noun phrase of the step, never example data: quoted values ("ana@example.edu"),
      // numbers, data tables and doc strings are left out, and the phrase ends at a preposition.
      const phrase = withoutQuotedText(step.text.split('\n')[0]).replace(/["'`“”«»]/g, ' ');
      const words = phrase.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w && !/^\d+$/.test(w)).map(w => w.toLowerCase());

      const verbIdx = words.findIndex(w => VERB_PATTERNS[verb]?.test(w));
      if (verbIdx !== -1 && verbIdx < words.length - 1) {
        // Try to find the next meaningful noun after the verb
        const nextWords = words.slice(verbIdx + 1).filter(w => !stopWords.has(w));
        if (nextWords.length > 0) {
          subject = nextWords[0];
          if (nextWords.length > 1 && nextWords[1].length > 2 && !PHRASE_BOUNDARIES.has(nextWords[1])) {
             subject += `_${nextWords[1]}`;
          }
        }
      } else {
        const subjectMatch = phrase.match(/(?:the|an?|el|la|un|una)\s+(\w+(?:\s+\w+)?)/i);
        if (subjectMatch) {
          subject = subjectMatch[1].toLowerCase().replace(/\s+/g, '_');
        }
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

export function extractQueries(parsed: ParsedFeature, sourceFile: string): Query[] {
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

export function extractEvents(
  parsed: ParsedFeature,
  sourceFile: string,
  commands: Command[]
): DomainEvent[] {
  const events: DomainEvent[] = [];

  // Explicit @event:Name tags replace the inference; the n-th event is emitted by the n-th command.
  const declared = declaredTagValues(parsed, 'event');
  if (declared.length) {
    return declared.map((name, i) => ({
      id: generateId('EVT'),
      name,
      eventType: name,
      payload: [],
      triggeredBy: commands[i] ? [commands[i].id] : commands[0] ? [commands[0].id] : [],
      source: { file: sourceFile, line: 0 },
      confidence: 1,
      inferenceSource: 'user',
    }));
  }

  for (const sc of parsed.scenarios) {
    for (const step of sc.steps) {
      if (!/event|publishes|emits|broadcasts|evento|emite/i.test(step.text)) continue;

      // Extract PascalCase Event, Quoted Event, or fallback Noun Phrase
      let eventName = '';
      const quoteMatch = step.text.match(/"([^"]+)"/);
      const pascalMatch = step.text.match(/\b([A-Z][a-zA-Z0-9]*Event)\b/);

      if (quoteMatch) {
        eventName = quoteMatch[1].replace(/[^a-zA-Z0-9]/g, '');
      } else if (pascalMatch) {
        eventName = pascalMatch[1];
      } else {
        // Fallback: capitalize remaining important words
        const words = step.text.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
        const stopWords = new Set(['a', 'an', 'the', 'el', 'la', 'un', 'una', 'is', 'to', 'from', 'with', 'published', 'broadcasts', 'emits', 'eventually']);
        eventName = words
          .filter(w => !stopWords.has(w.toLowerCase()))
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join('')
          .substring(0, 60);
        
        if (!eventName.toLowerCase().endsWith('event')) {
          eventName += 'Event';
        }
      }
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

export function extractStateMachines(parsed: ParsedFeature, sourceFile: string): StateMachine[] {
  const statesByEntity = new Map<string, Set<string>>();
  const transitions: StateTransition[] = [];

  // Scan all steps for state-related words
  const allStates: string[] = [];
  const entityName = featurePascalName(parsed);

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

export function extractInvariants(
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
          entity: featurePascalName(parsed),
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

export function extractAPIEndpoints(
  parsed: ParsedFeature,
  sourceFile: string,
  fields: FieldSpec[]
): APIEndpointHint[] {
  // Every generated backend serves one command route per feature (generators/kernel/app/shared.ts):
  //   POST /api/v1/<feature>/{id}/{command}, bearer JWT (tenant from a claim), optional Idempotency-Key.
  // The contract describes that route, so agents and API consumers are not sent to paths the service does not
  // serve. <feature> is the @aggregate tag or the feature name, accents removed, like the generated route.
  // HTTP codes named in the scenarios are not copied: the route answers with the codes below (a domain error,
  // whatever the scenario calls it, is a 422).
  const featureSlug = toKebab(featurePascalName(parsed));
  return [{
    id: generateId('API'),
    method: 'POST',
    path: `/api/v1/${featureSlug}/{id}/{command}`,
    operationId: `execute${featurePascalName(parsed)}Command`,
    requestFields: fields,
    responseFields: [],
    httpCodes: COMMAND_ROUTE_RESPONSES,
    authRequired: true,
    source: { file: sourceFile, line: 0 },
    confidence: 1,
    inferenceSource: 'deterministic',
  }];
}

/** Responses of the generated command route (docs/RUNTIME-KERNEL.md, kernel/app/shared.ts). */
export const COMMAND_ROUTE_RESPONSES: { code: string; description: string }[] = [
  { code: '202', description: 'Command accepted: the event was stored with the aggregate and the outbox' },
  { code: '200', description: 'Replayed: the same Idempotency-Key was already processed; the first result is returned' },
  { code: '401', description: 'Missing or invalid bearer token, or no tenant claim' },
  { code: '409', description: 'A request with the same Idempotency-Key is still in progress' },
  { code: '422', description: 'Domain validation error (business rule violated or unknown command)' }
];
