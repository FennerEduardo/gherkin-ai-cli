/* ==========================================================================
   gherkin-ai-cli - The project's domain glossary (PLAN-3.3.0-reverse-plus
   RV-10), optional: `reverse.glossary` in gherkin-ai.config.json names a file.

   Formats:
   - YAML or JSON: `terms: [{ term: Customer, synonyms: [Account, Client] }]`
     or a map `Customer: [Account, Client]`;
   - Markdown or text, one term per line: `- **Customer** (also: Account,
     Client): a person who buys`, `Customer: …`, `Customer — …`.
   Features may add terms with a `Glossary:` line in their description
   (`Glossary: data controller, SLA`), the same line `ghk lint` reads for
   acronyms.

   Where it is used:
   - `reverse propose`: an aggregate that is not a term becomes an open
     question (is it one of the terms under another name?);
   - `reverse coverage`, `accept --merge`, `sync`: a synonym on the same
     verb is `renamed`, not `undocumented`;
   - lint (GHK007): a term such as "data controller" is business
     vocabulary, not a code word;
   - `reverse propose --assist`: the terms are the vocabulary the model must use.
   Without a glossary, nothing changes.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

export interface Glossary {
  /** The file it was read from, relative to the project; undefined when only features declare terms. */
  file?: string;
  /** Every term, as written. */
  terms: string[];
  /** Lower-case synonym → lower-case term. */
  synonyms: Map<string, string>;
}

const EMPTY: Glossary = { terms: [], synonyms: new Map() };

function add(g: Glossary, term: string, synonyms: string[] = []): void {
  const t = term.trim().replace(/^\*+|\*+$/g, '').trim();
  if (!t || t.length > 60) return;
  if (!g.terms.some(x => x.toLowerCase() === t.toLowerCase())) g.terms.push(t);
  for (const s of synonyms.map(x => x.trim()).filter(Boolean)) g.synonyms.set(s.toLowerCase(), t.toLowerCase());
}

export function parseGlossary(text: string, file: string): Glossary {
  const g: Glossary = { file, terms: [], synonyms: new Map() };
  if (/\.(ya?ml|json)$/i.test(file)) {
    const data = /\.json$/i.test(file) ? JSON.parse(text) : yaml.parse(text);
    const list = Array.isArray(data?.terms) ? data.terms : undefined;
    if (list) for (const e of list) typeof e === 'string' ? add(g, e) : add(g, String(e?.term ?? ''), Array.isArray(e?.synonyms) ? e.synonyms.map(String) : []);
    else if (data && typeof data === 'object') for (const [term, syn] of Object.entries(data)) add(g, term, Array.isArray(syn) ? syn.map(String) : []);
    return g;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]\s+)?\*{0,2}([^*:=—–(|#\n]+?)\*{0,2}\s*(?:\((?:also|aka|synonyms?)\s*:?\s*([^)]+)\))?\s*(?::|—|–|\s-\s)\s*\S/i);
    if (m && !/^\s*#/.test(line)) add(g, m[1], m[2]?.split(',') ?? []);
  }
  return g;
}

/** Terms from `Glossary:` lines in feature descriptions (`Glossary: data controller, SLA`). */
export function featureGlossaryTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/^\s*Glossary:\s*(.+)$/gim)) for (const term of m[1].split(/[,;]/)) {
    const clean = term.split(/[=(—–:]/)[0].trim();
    if (clean) out.add(clean);
  }
  return [...out].sort();
}

/** The glossary of a project: the configured file (if any) plus the terms its features declare. */
export function loadGlossary(root: string, featureTexts: string[] = []): Glossary {
  let configured: string | undefined;
  try {
    const file = path.join(root, 'gherkin-ai.config.json');
    if (fs.existsSync(file)) configured = JSON.parse(fs.readFileSync(file, 'utf8'))?.reverse?.glossary;
  } catch { /* an invalid configuration is reported by ghk validate */ }
  let g: Glossary = { ...EMPTY, terms: [], synonyms: new Map() };
  if (configured) {
    const abs = path.resolve(root, configured);
    if (abs.startsWith(path.resolve(root) + path.sep) && fs.existsSync(abs)) {
      try { g = parseGlossary(fs.readFileSync(abs, 'utf8'), path.relative(root, abs).split(path.sep).join('/')); } catch { /* unreadable: no glossary */ }
    }
  }
  for (const t of featureGlossaryTerms(featureTexts)) add(g, t);
  g.terms.sort((a, b) => a.localeCompare(b));
  return g;
}

/** A word in canonical form: a synonym maps to its term. */
export function canonicalWord(g: Glossary, word: string): string {
  return g.synonyms.get(word.toLowerCase()) ?? word.toLowerCase();
}

/** Is a PascalCase or spaced name (`Order`, `DataController`, `data controller`) a term or a synonym of one? */
export function knownTerm(g: Glossary, name: string): boolean {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const all = new Set([...g.terms.map(t => t.toLowerCase()), ...g.synonyms.keys()]);
  const singular = (s: string) => s.replace(/ies$/, 'y').replace(/s$/, '');
  return all.has(spaced) || [...all].some(t => singular(t) === singular(spaced));
}
