/* ==========================================================================
   gherkin-ai-cli - Proposals against the existing specification
   (`ghk reverse`, PLAN-3.3.0 R-14, R-15)

   Every operation found in the code is compared with the commands the
   generator derives from the features that already exist (the same
   buildDomainModel every kernel generator renders):
   - documented: a feature declares the same command;
   - renamed: a feature declares the same verb on a related noun
     (CreatePeriod in the code, CreateAcademicPeriod in the feature): the
     behaviour is specified, the names drifted;
   - undocumented: no feature declares it.
   Commands a feature declares that no operation implements are spec-only
   (drift in the other direction). Behaviour coverage is the share of
   operations that are documented or renamed.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { parseGherkinText } from '../gherkin-parser';
import { buildDomainModel } from '../../generators/kernel/domain-model';
import { toSnake } from '../../utils/naming';
import type { BehaviorCandidate } from './candidates';
import { canonicalWord, loadGlossary, type Glossary } from './glossary';

export type MatchStatus = 'documented' | 'renamed' | 'undocumented';

export interface OperationMatch {
  aggregate: string;
  operation: string;
  type: 'command' | 'query';
  method: string;
  path: string;
  status: MatchStatus;
  /** The feature (relative path) and its command name, when documented or renamed. */
  feature?: string;
  specName?: string;
}

export interface SpecCommand {
  feature: string;
  aggregate: string;
  command: string;
}

export interface DedupReport {
  features: number;
  operations: OperationMatch[];
  specOnly: SpecCommand[];
  coverage: { operations: number; documented: number; renamed: number; undocumented: number; percent: number };
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.ghe', 'dist', 'build', 'target', 'vendor', 'generated-specs']);

/** Every .feature file under the project (not proposals, not build output), relative to the root. */
export function existingFeatures(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.feature')) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** The commands each feature declares, as the generator names them. Unparsable features are skipped. */
export function specCommands(root: string, features = existingFeatures(root)): SpecCommand[] {
  const out: SpecCommand[] = [];
  for (const feature of features) {
    try {
      const text = fs.readFileSync(path.join(root, feature), 'utf8');
      const model = buildDomainModel(parseGherkinText(text));
      for (const c of model.commands) out.push({ feature, aggregate: model.pascal, command: c.name });
      // Queries a feature declares (@query:GetOrder, as accepted reverse proposals do) specify read operations.
      for (const q of new Set([...text.matchAll(/@query[:=(]([A-Za-z][A-Za-z0-9_]*)/g)].map(m => m[1]))) out.push({ feature, aggregate: model.pascal, command: q });
    } catch { /* not a valid feature: lint reports it */ }
  }
  return out;
}

const words = (name: string) => toSnake(name).split('_');
const VERB_SYNONYMS: Record<string, string> = { add: 'create', register: 'create', new: 'create', place: 'create', submit: 'create', remove: 'delete', edit: 'update', modify: 'update', change: 'update', fetch: 'get', retrieve: 'get', find: 'get', list: 'get' };
const canonicalVerb = (v: string) => VERB_SYNONYMS[v] ?? v;

/** Same verb (or a synonym) and one noun phrase contained in the other; glossary synonyms are the same noun (RV-10). */
export function similarCommands(a: string, b: string, glossary?: Glossary): boolean {
  const canon = (w: string[]) => (glossary ? w.map(x => canonicalWord(glossary, x)) : w);
  const [va, ...na] = canon(words(a));
  const [vb, ...nb] = canon(words(b));
  if (canonicalVerb(va) !== canonicalVerb(vb) || !na.length || !nb.length) return false;
  const contains = (x: string[], y: string[]) => y.every(w => x.includes(w) || x.includes(w.replace(/s$/, '')));
  return contains(na, nb) || contains(nb, na);
}

export function compareWithSpec(root: string, candidates: BehaviorCandidate[]): DedupReport {
  const features = existingFeatures(root);
  const spec = specCommands(root, features);
  const glossary = loadGlossary(root);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const used = new Set<SpecCommand>();
  const operations: OperationMatch[] = candidates.map(c => {
    const base = { aggregate: c.aggregate, operation: c.operation.name, type: c.operation.type, method: c.operation.method, path: c.operation.path };
    const exact = spec.find(s => norm(s.command) === norm(c.operation.name));
    if (exact) { used.add(exact); return { ...base, status: 'documented' as const, feature: exact.feature, specName: exact.command }; }
    // Prefer a similar command in a feature about the same aggregate.
    const similar = spec.filter(s => similarCommands(s.command, c.operation.name, glossary)).sort((x, y) => Number(norm(y.aggregate).includes(norm(c.aggregate))) - Number(norm(x.aggregate).includes(norm(c.aggregate))))[0];
    if (similar) { used.add(similar); return { ...base, status: 'renamed' as const, feature: similar.feature, specName: similar.command }; }
    return { ...base, status: 'undocumented' as const };
  });
  const specOnly = spec.filter(s => !used.has(s) && !operations.some(o => o.specName === s.command));
  const documented = operations.filter(o => o.status === 'documented').length;
  const renamed = operations.filter(o => o.status === 'renamed').length;
  const total = operations.length;
  return {
    features: features.length,
    operations,
    specOnly,
    coverage: { operations: total, documented, renamed, undocumented: total - documented - renamed, percent: total ? Math.round(((documented + renamed) / total) * 100) : 100 }
  };
}
