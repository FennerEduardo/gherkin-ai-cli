/* ==========================================================================
   gherkin-ai-cli - Round-trip score for `ghk reverse` (PLAN-3.3.0 §4)

   feature → `ghk generate` → code → `ghk reverse` → model, compared with the
   model the generator built from the original feature (the same
   buildDomainModel every kernel generator renders): aggregates, commands
   and the events they record. Wording is not compared. The F1 per stack is
   what decides an analyzer's maturity (beta ≥ 0.80, experimental ≥ 0.60).
   ========================================================================== */

import fs from 'fs';
import { parseGherkinText } from '../gherkin-parser';
import { buildDomainModel } from '../../generators/kernel/domain-model';
import type { BehaviorCandidate } from './candidates';

export interface ModelNames {
  aggregates: string[];
  commands: string[];
  events: string[];
}

export interface SetScore {
  expected: number;
  found: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  extra: string[];
}

export interface RoundTripScore {
  aggregates: SetScore;
  commands: SetScore;
  events: SetScore;
  /** Micro-averaged over the three sets. */
  f1: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const round = (n: number) => Math.round(n * 1000) / 1000;

export function scoreSet(expected: string[], found: string[]): SetScore {
  const e = new Map(expected.map(x => [norm(x), x]));
  const f = new Map(found.map(x => [norm(x), x]));
  const matched = [...e.keys()].filter(k => f.has(k)).length;
  const precision = f.size ? matched / f.size : (e.size ? 0 : 1);
  const recall = e.size ? matched / e.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    expected: e.size, found: f.size, matched, precision: round(precision), recall: round(recall), f1: round(f1),
    missing: [...e.entries()].filter(([k]) => !f.has(k)).map(([, v]) => v).sort(),
    extra: [...f.entries()].filter(([k]) => !e.has(k)).map(([, v]) => v).sort()
  };
}

/** What the generator built from the features: aggregate, command and event names. */
export function expectedModel(featureFiles: string[]): ModelNames {
  const out: ModelNames = { aggregates: [], commands: [], events: [] };
  for (const file of featureFiles) {
    const model = buildDomainModel(parseGherkinText(fs.readFileSync(file, 'utf8')));
    out.aggregates.push(model.pascal);
    out.commands.push(...model.commands.map(c => c.name));
    out.events.push(...model.commands.map(c => c.event));
  }
  return out;
}

/** What reverse found: aggregates, commands (queries are not commands) and published events. */
export function foundModel(candidates: BehaviorCandidate[]): ModelNames {
  const commands = candidates.filter(c => c.operation.type === 'command');
  return {
    aggregates: [...new Set(candidates.map(c => c.aggregate))],
    commands: [...new Set(commands.map(c => c.operation.name))],
    events: [...new Set(commands.flatMap(c => c.events))]
  };
}

export function scoreRoundTrip(expected: ModelNames, found: ModelNames): RoundTripScore {
  const aggregates = scoreSet(expected.aggregates, found.aggregates);
  const commands = scoreSet(expected.commands, found.commands);
  const events = scoreSet(expected.events, found.events);
  const sets = [aggregates, commands, events];
  const matched = sets.reduce((s, x) => s + x.matched, 0);
  const exp = sets.reduce((s, x) => s + x.expected, 0);
  const fnd = sets.reduce((s, x) => s + x.found, 0);
  const p = fnd ? matched / fnd : 0;
  const r = exp ? matched / exp : 0;
  return { aggregates, commands, events, f1: round(p + r ? (2 * p * r) / (p + r) : 0) };
}
