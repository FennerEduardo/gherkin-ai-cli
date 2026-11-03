/* ==========================================================================
   gherkin-ai-cli - `ghk reverse sync`: living specifications
   (PLAN-3.3.0-reverse-plus RV-02)

   Compares the accepted characterization features (tagged
   @reverse-engineered, versioned in git, so CI needs nothing from .ghe/)
   with what reverse would propose from the code today, operation by
   operation:
   - new operations in an aggregate a feature already characterizes;
   - operations a feature specifies that the code no longer has;
   - changed outcomes: the status written, the event published, the
     success outcome or the failure scenarios differ;
   - moved evidence: same behaviour, the `# evidence:` lines moved.
   The first three are drift (exit 7). sync never edits a feature: it
   writes a patch per feature in .ghe/patches/ that rewrites the feature as
   reverse proposes it today, to review and `git apply`.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { BehaviorCandidate } from './candidates';
import type { SourceEvidence } from './evidence';
import { existingFeatures, compareWithSpec, specCommands } from './dedup';
import { renderAggregate } from './renderer';

export const NOT_ACCEPTED_PREFIX = '# Not accepted in review:';

interface ParsedScenario {
  operation: string;
  name: string;
  outcomes: string[];
  evidence: string[];
}

export interface CharacterizationFeature {
  file: string;
  aggregate: string;
  operations: string[];
  /** What the review left out at accept time, `Operation` or `Operation — scenario name`: not reported as new. */
  notAccepted: string[];
  scenarios: ParsedScenario[];
}

/**
 * Reads a feature in the format the reverse renderer writes: `@aggregate:` on the feature, `@command:` or
 * `@query:` on each scenario, `# evidence: <id> <file>:<line>, …` before steps. Hand edits that keep those
 * tags are read too; other features return undefined.
 */
export function parseCharacterization(file: string, text: string): CharacterizationFeature | undefined {
  if (!/^\s*@reverse-engineered\b/m.test(text)) return undefined;
  const aggregate = text.match(/@aggregate:([A-Za-z][A-Za-z0-9_]*)/)?.[1];
  if (!aggregate) return undefined;
  const notAccepted = [...text.matchAll(/^# Not accepted in review:\s*(.+)$/gm)].map(m => m[1].trim());
  const scenarios: ParsedScenario[] = [];
  let tags = '';
  let current: ParsedScenario | undefined;
  let pendingEvidence: string[] = [];
  let inOutcome = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const ev = line.match(/^# evidence:\s*(.+)$/);
    if (ev) { pendingEvidence = ev[1].split(',').map(s => s.trim().split(/\s+/)[1]).filter(Boolean) as string[]; continue; }
    if (line.startsWith('@')) { tags = line; continue; }
    const sc = line.match(/^Scenario(?: Outline)?:\s*(.+)$/);
    if (sc) {
      const op = tags.match(/@(?:command|query):([A-Za-z][A-Za-z0-9_]*)/)?.[1];
      current = op ? { operation: op, name: sc[1].trim(), outcomes: [], evidence: [] } : undefined;
      if (current) scenarios.push(current);
      tags = '';
      inOutcome = false;
      pendingEvidence = [];
      continue;
    }
    const step = line.match(/^(Given|When|Then|And|But)\s+(.+)$/);
    if (step && current) {
      if (step[1] === 'Then') inOutcome = true;
      else if (step[1] === 'Given' || step[1] === 'When') inOutcome = false;
      if (inOutcome) current.outcomes.push(step[2]);
      current.evidence.push(...pendingEvidence);
      pendingEvidence = [];
    }
  }
  return { file, aggregate, operations: [...new Set(scenarios.map(s => s.operation))], notAccepted, scenarios };
}

export interface SyncChange {
  feature: string;
  operation: string;
  added: string[];
  removed: string[];
}

export interface SyncReport {
  status: 'beta';
  /** Characterization features compared. */
  features: number;
  newOperations: { feature: string; aggregate: string; operation: string; method: string; path: string }[];
  missingOperations: { feature: string; operation: string }[];
  changed: SyncChange[];
  moved: { feature: string; operation: string; scenario: string; before: string[]; after: string[] }[];
  /** With allFeatures: commands other features declare that the code does not implement. */
  specOnly: { feature: string; command: string }[];
  /** Operations in aggregates no feature characterizes (not drift; see `reverse coverage`). */
  uncovered: number;
  drift: boolean;
  patches: string[];
}

const scenarioSummary = (s: ParsedScenario) => [`scenario: ${s.name}`, ...s.outcomes.map(o => `then: ${o}`)];

export interface SyncOptions {
  /** Also compare the features gherkin-ai did not propose (spec-only commands are drift). */
  allFeatures?: boolean;
  /** Write the patches (default true); false for --dry-run. */
  write?: boolean;
  /** Writes one patch; returns its path relative to the root. Injected so the core has no governance import. */
  writePatch?: (featureFile: string, content: string) => string;
}

export function runSync(root: string, candidates: BehaviorCandidate[], evidence: SourceEvidence[], options: SyncOptions = {}): SyncReport {
  const files = existingFeatures(root);
  const characterized: CharacterizationFeature[] = [];
  for (const f of files) {
    try {
      const parsed = parseCharacterization(f, fs.readFileSync(path.join(root, f), 'utf8'));
      if (parsed) characterized.push(parsed);
    } catch { /* unreadable: lint reports it */ }
  }
  const spec = compareWithSpec(root, candidates);
  const documentedElsewhere = new Set(spec.operations.filter(o => o.status !== 'undocumented').map(o => o.operation));
  const report: SyncReport = { status: 'beta', features: characterized.length, newOperations: [], missingOperations: [], changed: [], moved: [], specOnly: [], uncovered: 0, drift: false, patches: [] };
  const characterizedAggregates = new Set(characterized.map(c => c.aggregate.toLowerCase()));

  for (const feature of characterized) {
    const inCode = candidates.filter(c => c.aggregate.toLowerCase() === feature.aggregate.toLowerCase());
    const codeOps = new Set(inCode.map(c => c.operation.name));
    const featureOps = new Set(feature.operations);
    // An operation another feature already documents is not new here; one the review left out is not new either.
    const others = specNamesOtherThan(root, feature.file);
    const fresh = inCode.filter(c => !featureOps.has(c.operation.name) && !feature.notAccepted.includes(c.operation.name) && !others.has(c.operation.name));
    for (const c of fresh) report.newOperations.push({ feature: feature.file, aggregate: c.aggregate, operation: c.operation.name, method: c.operation.method, path: c.operation.path });
    // An operation may have moved to another aggregate (a renamed controller): it is missing only when no aggregate has it.
    const anywhere = new Set(candidates.map(c => c.operation.name));
    for (const op of feature.operations.filter(o => !codeOps.has(o) && !anywhere.has(o))) report.missingOperations.push({ feature: feature.file, operation: op });

    // Outcomes: render what reverse proposes today for the operations both sides have, and compare.
    const both = inCode.filter(c => featureOps.has(c.operation.name));
    const today = both.length ? parseCharacterization(feature.file, renderAggregate(feature.aggregate, both, evidence).text.replace(/^@reverse-engineered @characterization @needs-review$/m, '@reverse-engineered @characterization')) : undefined;
    for (const op of [...featureOps].filter(o => codeOps.has(o)).sort()) {
      const before = feature.scenarios.filter(s => s.operation === op);
      const after = today?.scenarios.filter(s => s.operation === op && !feature.notAccepted.includes(`${op} — ${s.name}`)) ?? [];
      const b = new Set(before.flatMap(scenarioSummary));
      const a = new Set(after.flatMap(scenarioSummary));
      const added = [...a].filter(x => !b.has(x)).sort();
      const removed = [...b].filter(x => !a.has(x)).sort();
      if (added.length || removed.length) { report.changed.push({ feature: feature.file, operation: op, added, removed }); continue; }
      for (const s of before) {
        const now = after.find(x => x.name === s.name);
        const locs = (e: string[]) => [...new Set(e)].sort();
        if (now && locs(now.evidence).join('|') !== locs(s.evidence).join('|')) report.moved.push({ feature: feature.file, operation: op, scenario: s.name, before: locs(s.evidence), after: locs(now.evidence) });
      }
    }

    const touched = fresh.length || report.missingOperations.some(m => m.feature === feature.file) || report.changed.some(c => c.feature === feature.file) || report.moved.some(m => m.feature === feature.file);
    if (touched && options.write !== false && options.writePatch) {
      const keep = inCode.filter(c => featureOps.has(c.operation.name) || fresh.includes(c));
      const rendered = keep.length ? renderAggregate(feature.aggregate, keep, evidence).text : '';
      const text = rendered ? acceptedFeatureText(rendered, feature.notAccepted) : '';
      report.patches.push(options.writePatch(feature.file, text));
    }
  }

  report.uncovered = spec.operations.filter(o => o.status === 'undocumented' && !characterizedAggregates.has(o.aggregate.toLowerCase()) && !documentedElsewhere.has(o.operation)).length;
  if (options.allFeatures) {
    const reverseFiles = new Set(characterized.map(c => c.file));
    report.specOnly = spec.specOnly.filter(s => !reverseFiles.has(s.feature)).map(s => ({ feature: s.feature, command: s.command }));
  }
  report.drift = Boolean(report.newOperations.length || report.missingOperations.length || report.changed.length || report.specOnly.length);
  return report;
}

/** Commands declared by every feature except one (an operation documented elsewhere is not new). */
function specNamesOtherThan(root: string, feature: string): Set<string> {
  return new Set(specCommands(root).filter(s => s.feature !== feature).map(s => s.command));
}

/**
 * The text `accept` writes: reviewed (no @needs-review), the evidence comments kept, and the operations the
 * review left out listed so `sync` does not report them as new.
 */
export function acceptedFeatureText(text: string, notAccepted: string[] = []): string {
  let out = text
    .replace(/^# Proposed by `ghk reverse` \(beta\) from the source code\.\n/m, '# Accepted from `ghk reverse` (beta). The `# evidence:` comments point to the code as it was when the proposal was made.\n')
    .replace(/^# Review every scenario, then run `ghk reverse accept` to move it into the specifications\.\n/m, '')
    .replace(/^@reverse-engineered @characterization @needs-review$/m, '@reverse-engineered @characterization');
  const list = [...new Set(notAccepted)].sort();
  if (list.length) out = out.replace(/^(# Characterization: .*\n)/m, `$1${list.map(l => `${NOT_ACCEPTED_PREFIX} ${l}\n`).join('')}`);
  return out;
}
