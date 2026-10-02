/* ==========================================================================
   gherkin-ai-cli - Language-neutral domain kernel model

   Every stack generator renders the same kernel from this model, so all
   generated projects share one behavioral contract that their own unit
   tests verify:
     - a new aggregate starts in `initialState` with version 0 and no events
     - each command, when valid, records exactly one event and bumps version
     - a command without an id is rejected with a validation error
   BDD step definitions are derived from the feature's unique steps and are
   generated as *pending* (wired to the feature, not yet implemented).
   ========================================================================== */

import type { ParsedFeature } from '../../core/gherkin-parser';
import { buildIR } from '../../core/ir-builder';

export interface KernelCommand {
  /** PascalCase, e.g. PayValidCard */
  name: string;
  /** camelCase method name, e.g. payValidCard */
  method: string;
  /** snake_case, e.g. pay_valid_card */
  snake: string;
  /** Event recorded when the command succeeds (PascalCase, without "Event" suffix). */
  event: string;
}

export interface KernelStep {
  keyword: 'Given' | 'When' | 'Then';
  text: string;
  /** Stable identifier usable as a function name in any language: given_an_order_with_amount_100 */
  id: string;
}

export interface DomainModel {
  feature: string;
  pascal: string;
  camel: string;
  kebab: string;
  snake: string;
  /** Lowercase alphanumerics only (package / module safe). */
  flat: string;
  initialState: string;
  states: string[];
  commands: KernelCommand[];
  events: string[];
  steps: KernelStep[];
  scenarios: { name: string; steps: KernelStep[] }[];
}

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

export const toPascal = (s: string) => words(s).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'App';
export const toCamel = (s: string) => { const p = toPascal(s); return p.charAt(0).toLowerCase() + p.slice(1); };
export const toSnake = (s: string) => words(s).map(w => w.toLowerCase()).join('_') || 'app';
export const toKebab = (s: string) => words(s).map(w => w.toLowerCase()).join('-') || 'app';
export const toFlat = (s: string) => words(s).map(w => w.toLowerCase()).join('') || 'app';

const IDENT_START = /^[A-Za-z]/;

function safeIdent(raw: string, fallback: string): string {
  return IDENT_START.test(raw) ? raw : `${fallback}${raw}`;
}

export function buildDomainModel(input: ParsedFeature): DomainModel {
  // Callers (plugins, tests, MCP) sometimes pass partial features: normalize before analysis.
  const parsed: ParsedFeature = {
    ...input,
    featureName: input.featureName || 'App',
    descriptionLines: input.descriptionLines ?? [],
    tags: input.tags ?? [],
    scenarios: (input.scenarios ?? []).map(sc => ({ ...sc, tags: sc.tags ?? [], steps: sc.steps ?? [] })),
    domainAnalysis: {
      actors: input.domainAnalysis?.actors ?? [],
      commands: input.domainAnalysis?.commands ?? [],
      queries: input.domainAnalysis?.queries ?? [],
      events: input.domainAnalysis?.events ?? [],
      fields: input.domainAnalysis?.fields ?? [],
      httpCodes: input.domainAnalysis?.httpCodes ?? [],
      fixtures: input.domainAnalysis?.fixtures ?? []
    }
  };
  const ir = buildIR(parsed, 'feature.feature');
  const pascal = safeIdent(toPascal(parsed.featureName), 'Feature');

  const events = [...new Set((ir.events || []).map(e => toPascal(String(e.name).replace(/Event$/, ''))))].filter(Boolean);
  const defaultEvent = `${pascal}Processed`;

  const commandNames = [...new Set((ir.commands || []).map(c => toPascal(String(c.name))))].filter(Boolean);
  if (commandNames.length === 0) commandNames.push(`Process${pascal}`);
  const commands: KernelCommand[] = commandNames.map((name, i) => {
    const n = safeIdent(name, 'Do');
    return { name: n, method: toCamel(n), snake: toSnake(n), event: events[i] ?? (i === 0 && events.length ? events[0] : `${n}Completed`) };
  });

  const sm = (ir.stateMachines || [])[0];
  const states = ['PENDING', ...((sm?.states as string[]) || []).map(s => toSnake(s).toUpperCase())].filter((s, i, a) => a.indexOf(s) === i);

  const seen = new Map<string, KernelStep>();
  const usedIds = new Set<string>();
  const scenarios = parsed.scenarios.map(sc => {
    let last: KernelStep['keyword'] = 'Given';
    const steps = sc.steps.map(st => {
      const kw = st.keyword.trim();
      if (kw === 'Given' || kw === 'When' || kw === 'Then') last = kw;
      const key = `${last}|${st.text}`;
      let step = seen.get(key);
      if (!step) {
        let id = safeIdent(`${last.toLowerCase()}_${toSnake(st.text)}`.slice(0, 80), 'step_');
        for (let n = 2; usedIds.has(id); n++) id = `${id}_${n}`;
        usedIds.add(id);
        step = { keyword: last, text: st.text, id };
        seen.set(key, step);
      }
      return step;
    });
    return { name: sc.name, steps };
  });

  return {
    feature: parsed.featureName,
    pascal,
    camel: toCamel(pascal),
    kebab: toKebab(pascal),
    snake: toSnake(pascal),
    flat: toFlat(pascal),
    initialState: 'PENDING',
    states,
    commands,
    events: [...new Set([...commands.map(c => c.event), ...events, defaultEvent])],
    steps: [...seen.values()],
    scenarios
  };
}

/** Escapes a step text for a Cucumber Expression (used by cucumber-js, Cucumber-JVM, Reqnroll, godog regex variants differ). */
export function cucumberExpression(text: string): string {
  return text.replace(/([\\(){}/])/g, '\\$1');
}

/** Escapes a step text as an anchored regular expression. */
export function stepRegex(text: string): string {
  return `^${text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`;
}
