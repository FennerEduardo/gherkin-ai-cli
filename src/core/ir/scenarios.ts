/* ==========================================================================
   gherkin-ai-cli - IR builder: Scenario enrichment, categories, ambiguities, contradictions and completeness
   ========================================================================== */

import { ParsedFeature, ScenarioModel } from '../parsers/specification-interface';
import { Actor, Command, Query, EnrichedScenario, ScenarioCategory, Invariant, Constraint } from '../semantic-ir';
import { declaredTagValues, toSnake } from '../../utils/naming';
import path from 'path';
import { generateId, AUTH_PATTERNS, ERROR_PATTERNS } from './patterns';

// ---------------------------------------------------------------------------
// Scenario Enrichment
// ---------------------------------------------------------------------------

export function enrichScenarios(
  scenarios: ScenarioModel[],
  sourceFile: string,
  actors: Actor[],
  commands: Command[],
  queries: Query[]
): EnrichedScenario[] {
  return scenarios.map(sc => {
    const category = categorizeScenario(sc);
    const categories = categorizeScenarioLabels(sc);
    const actorIds = actors
      .filter(a => sc.steps.some(s => s.text.toLowerCase().includes(a.name)))
      .map(a => a.id);

    // Declared commands (@command tags): the scenario's own tag, or every scenario with an action when they are
    // declared on the feature. Inferred commands: the subject appears in a When step.
    const scenarioDeclared = new Set(declaredTagValues({ tags: sc.tags }, 'command').map(n => toSnake(n)));
    const anyScenarioDeclares = scenarios.some(s => declaredTagValues({ tags: s.tags }, 'command').length > 0);
    const cmdIds = commands
      .filter(c => c.inferenceSource === 'user'
        ? scenarioDeclared.has(`${c.verb}_${c.subject}`) || (!anyScenarioDeclares && sc.steps.some(s => s.keyword === 'When'))
        : sc.steps.some(s => s.keyword === 'When' && s.text.toLowerCase().includes(c.subject)))
      .map(c => c.id);

    const qryIds = queries
      .filter(q => sc.steps.some(s => s.keyword === 'Then'))
      .map(q => q.id);

    return {
      id: generateId('SCN'),
      name: sc.name,
      category,
      categories,
      tags: sc.tags,
      actors: actorIds.length > 0 ? actorIds : (actors[0] ? [actors[0].id] : []),
      commands: cmdIds,
      queries: qryIds,
      preconditions: sc.steps.filter(s => s.keyword === 'Given').map(s => s.text),
      actions: sc.steps.filter(s => s.keyword === 'When').map(s => s.text),
      expectations: sc.steps.filter(s => s.keyword === 'Then').map(s => s.text),
      coveredInvariants: [],
      missingPaths: ESSENTIAL_CATEGORIES.filter(c => !categories.includes(c)),
      source: { file: sourceFile, line: sc.line ?? 0 },
      confidence: 1.0,
      inferenceSource: 'deterministic' as const,
    };
  });
}

/** Every category a scenario covers, most specific first. A scenario with none of them is a happy path. */
export function categorizeScenarioLabels(sc: Pick<ScenarioModel, 'steps' | 'tags' | 'name'>): ScenarioCategory[] {
  const allText = sc.steps.map(s => s.text).join(' ');
  const tags = sc.tags.join(' ');
  const combined = `${allText} ${tags} ${sc.name}`;
  const labels: ScenarioCategory[] = [];
  const add = (c: ScenarioCategory, hit: boolean) => { if (hit && !labels.includes(c)) labels.push(c); };

  add('validation', /\b(valid(ation|ates?|ated|ating|ar|a|ación)?|invalid(ated)?|inválid[oa]?|required|requerid[oa]|obligatori[oa]|malformed|mal.?formad[oa]|too.?(long|short)|demasiado.?(larg|cort)[oa])\b/i.test(combined) ||
    /\b(status|http|code|código|estado)\s*(400|422)\b/i.test(combined));
  add('error-handling', ERROR_PATTERNS.some(p => p.test(combined)));
  add('authorization', AUTH_PATTERNS.some(p => p.test(combined)));
  add('security', /\b(security|seguridad|vulnerability|vulnerabilidad|injection|inyección|xss|csrf)\b/i.test(combined));
  add('timeout', /\b(timeout|time.?out|tiempo.?agotado)\b/i.test(combined));
  add('retry', /\b(retry|retries|reinten(to|tar))\b/i.test(combined));
  add('idempotency', /\b(idempoten(t|cy|ce)|idempotenc(ia|e)|duplicate|duplicad[oa])\b/i.test(combined));
  add('concurrency', /\b(concurrent|concurrently|concurren(cia|te)|parallel|paralel(o|a)|race)\b/i.test(combined));
  add('partial-failure', /\b(partial|parcial)\b/i.test(combined));
  add('recovery', /\b(recover|recuper(ar|ación)|rollback|compensat(e|ion)|compensa(r|ción))\b/i.test(combined));
  add('performance', /\b(performance|rendimiento|load|carga|latency|latencia)\b/i.test(combined));
  add('observability', /\b(observ\w*|monitor\w*|log(s|ged|ging)?|metrics?|métricas?|trac(e|ing))\b/i.test(combined));
  add('edge-case', /\b(edge|edge.?case|borde|límite|boundary)\b/i.test(combined));
  // Context such as "Given a logged-in teacher" does not stop a scenario from being the happy path.
  const failing: ScenarioCategory[] = ['validation', 'error-handling', 'timeout', 'partial-failure', 'security'];
  add('happy-path', !labels.some(l => failing.includes(l)));

  return labels;
}

export function categorizeScenario(sc: ScenarioModel): ScenarioCategory {
  const labels = categorizeScenarioLabels(sc);
  // A successful scenario run by an authenticated actor is primarily a happy path.
  return labels.includes('happy-path') ? (labels.find(l => l !== 'authorization') as ScenarioCategory) : labels[0];
}

// ---------------------------------------------------------------------------
// Quality Analysis
// ---------------------------------------------------------------------------

export const ESSENTIAL_CATEGORIES: ScenarioCategory[] = ['happy-path', 'validation', 'authorization', 'error-handling'];

/** Union of every label of every scenario. */
export function coveredCategories(scenarios: EnrichedScenario[]): Set<ScenarioCategory> {
  return new Set(scenarios.flatMap(s => s.categories ?? [s.category]));
}

export function detectMissingScenarioCategories(scenarios: EnrichedScenario[]): ScenarioCategory[] {
  const covered = coveredCategories(scenarios);
  return ESSENTIAL_CATEGORIES.filter(c => !covered.has(c));
}

export function detectAmbiguities(parsed: ParsedFeature): string[] {
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

export function detectContradictions(
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

export function calculateScenarioCompleteness(
  scenarios: EnrichedScenario[],
  missingCategories: ScenarioCategory[]
): number {
  if (scenarios.length === 0) return 0;
  const essential = 4; // happy-path, validation, authorization, error-handling
  const covered = essential - missingCategories.length;
  return Math.round((covered / essential) * 100);
}

export function calculateConstraintCoverage(
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
