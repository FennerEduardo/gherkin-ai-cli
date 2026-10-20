/* ==========================================================================
   gherkin-ai-cli - IR builder: Traceability map, assumptions and risks
   ========================================================================== */

import { ParsedFeature } from '../parsers/specification-interface';
import {
  Command,
  Query,
  DomainEvent,
  EnrichedScenario,
  Invariant,
  APIEndpointHint,
  Assumption,
  Risk,
  TraceabilityMap,
  TraceabilityLink
} from '../semantic-ir';
import { generateId, VERB_PATTERNS, AUTH_PATTERNS, ERROR_PATTERNS } from './patterns';

// ---------------------------------------------------------------------------
// Traceability Map Builder
// ---------------------------------------------------------------------------

export function buildTraceabilityMap(
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

  // Commands → API Endpoints: every command is served by the feature's command route ({command} parameter).
  for (const ep of endpoints) {
    for (const cmd of commands) {
      links.push({
        from: { type: 'command', id: cmd.id },
        to: { type: 'api-endpoint', id: ep.id },
        relationship: 'implements',
      });
    }
  }

  // An event is tested when a Then step asserts it, or when a tested command emits it.
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const testedCommands = new Set(scenarios.flatMap(s => s.commands));
  const testedEvents = events.filter(evt => {
    const name = squash(evt.name);
    const asserted = !!name && scenarios.some(sc => sc.expectations.some(e => squash(e).includes(name)));
    const viaCommand = evt.triggeredBy.some(id => testedCommands.has(id)) ||
      commands.some(c => testedCommands.has(c.id) && c.emittedEvents.includes(evt.id));
    if (asserted) {
      for (const sc of scenarios.filter(s => s.expectations.some(e => squash(e).includes(name)))) {
        links.push({ from: { type: 'scenario', id: sc.id }, to: { type: 'event', id: evt.id }, relationship: 'tests' });
      }
    }
    return asserted || viaCommand;
  });

  const total = commands.length + queries.length + events.length;
  const tested = new Set(scenarios.flatMap(s => [...s.commands, ...s.queries])).size + testedEvents.length;

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
// Risk & Assumption Extraction
// ---------------------------------------------------------------------------

export function extractAssumptions(parsed: ParsedFeature, sourceFile: string): Assumption[] {
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

export function extractRisks(parsed: ParsedFeature, sourceFile: string): Risk[] {
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

