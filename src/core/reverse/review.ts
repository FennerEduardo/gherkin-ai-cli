/* ==========================================================================
   gherkin-ai-cli - `ghk reverse explain` and `ghk reverse review`
   (PLAN-3.3.0-reverse-plus RV-01, RV-03)

   explain: for one operation, where every name comes from (operation,
   aggregate), why it has its confidence, and the evidence chain behind it
   (endpoint → guards → input → calls → persistence → state → events →
   failures → response → tests), each link with its file and line.

   review: the proposals scenario by scenario with the code behind each step
   (a few lines around every `# evidence:` location, secrets redacted), and
   the reviewer's decisions in .ghe/reverse/review.json. A decision is keyed
   by operation and scenario name and remembers the evidence it was made on:
   when the code under a scenario changes, the decision is stale and counts
   as not reviewed. `accept` then takes the approved scenarios only.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { redactSensitive } from '../security';
import type { BehaviorCandidate, ScenarioCandidate } from './candidates';
import { aggregateFromEndpoint, operationName } from './candidates';
import type { EndpointMetadata, EvidenceConfidence, EvidenceKind, SourceEvidence } from './evidence';


export const REVIEW_FILE = 'review.json';

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

export type ChainRole = 'endpoint' | 'guard' | 'input' | 'call' | 'persistence' | 'state' | 'event' | 'failure' | 'response' | 'test' | 'other';

const ROLE_OF: Record<EvidenceKind, ChainRole> = {
  'http-endpoint': 'endpoint',
  'authorization-rule': 'guard',
  'input-contract': 'input',
  'validation-rule': 'input',
  'service-call': 'call',
  'repository-query': 'persistence',
  entity: 'persistence',
  'state-value': 'state',
  'domain-event': 'event',
  'error-condition': 'failure',
  'success-response': 'response',
  'test-case': 'test'
};
const ROLE_ORDER: ChainRole[] = ['endpoint', 'guard', 'input', 'call', 'persistence', 'state', 'event', 'failure', 'response', 'test', 'other'];

export interface ChainLink {
  role: ChainRole;
  id: string;
  kind: EvidenceKind;
  description: string;
  file: string;
  line: number;
  extractor: string;
  confidence: EvidenceConfidence;
}

export interface Explanation {
  operation: string;
  type: 'command' | 'query';
  aggregate: string;
  endpoint: string;
  /** Where the operation name comes from. */
  name: { origin: 'declared' | 'operationId' | 'handler' | 'path' | 'disambiguated'; detail: string };
  /** Where the aggregate comes from. */
  aggregateOrigin: { origin: 'declared' | 'path' | 'owner' | 'first-segment'; detail: string };
  confidence: { level: EvidenceConfidence; reason: string };
  chain: ChainLink[];
  scenarios: { name: string; category: string; confidence: EvidenceConfidence; steps: { keyword: string; text: string; evidence: string[] }[] }[];
  openQuestions: string[];
}

const link = (e: SourceEvidence): ChainLink => ({
  role: ROLE_OF[e.kind] ?? 'other', id: e.id, kind: e.kind, description: e.description,
  file: e.location.file, line: e.location.startLine, extractor: e.extractor, confidence: e.confidence
});

/** `PlaceOrder`, `placeorder`, `POST /orders` or `POST /orders/{id}/cancel`. */
export function findOperation(candidates: BehaviorCandidate[], target: string): BehaviorCandidate[] {
  const t = target.trim();
  const m = t.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
  if (m) {
    const norm = (p: string) => p.replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, '{}').replace(/\/$/, '');
    return candidates.filter(c => c.operation.method === m[1].toUpperCase() && norm(c.operation.path) === norm(m[2]));
  }
  return candidates.filter(c => c.operation.name.toLowerCase() === t.toLowerCase());
}

export function explainOperation(candidate: BehaviorCandidate, evidence: SourceEvidence[], unresolved: { endpoint?: string; question: string }[] = []): Explanation {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const endpoints = candidate.endpointEvidence.map(id => byId.get(id)).filter((e): e is SourceEvidence => Boolean(e));
  const code = endpoints.find(e => e.extractor !== 'openapi') ?? endpoints[0];
  const meta = (code?.metadata ?? {}) as unknown as EndpointMetadata;
  const operationId = endpoints.map(e => (e.metadata as any)?.operationId).find(Boolean) as string | undefined;
  const ids = new Set(candidate.endpointEvidence);
  const related = evidence.filter(e => e.references.some(r => ids.has(r)));
  const stepIds = new Set(candidate.scenarios.flatMap(s => s.steps.flatMap(st => st.evidence)));
  const chainEvidence = [...new Map([...endpoints, ...related, ...[...stepIds].map(id => byId.get(id)).filter((e): e is SourceEvidence => Boolean(e))].map(e => [e.id, e])).values()];
  const chain = chainEvidence.map(link).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));

  // Name origin: the same rules as operationName(), in its order.
  const plain = meta.path ? operationName(meta, candidate.aggregate, operationId) : undefined;
  let name: Explanation['name'];
  if (meta.command) name = { origin: 'declared', detail: `the code declares the command ${meta.command}` };
  else if (plain && plain.name !== candidate.operation.name) name = { origin: 'disambiguated', detail: `${plain.name}, plus the path segments that tell ${meta.method} ${meta.path} apart from another endpoint of ${candidate.aggregate} with the same name` };
  else if (operationId && operationName({ ...meta, handler: undefined }, candidate.aggregate, operationId).name === candidate.operation.name && operationName({ ...meta, handler: undefined }, candidate.aggregate).name !== candidate.operation.name) name = { origin: 'operationId', detail: `the OpenAPI operationId "${operationId}"` };
  else if (meta.handler && operationName({ ...meta, handler: undefined }, candidate.aggregate).name !== candidate.operation.name) name = { origin: 'handler', detail: `the handler ${meta.owner ? `${meta.owner}.` : ''}${meta.handler}` };
  else name = { origin: 'path', detail: `${meta.method} ${meta.path} by REST convention (${candidate.operation.type === 'query' ? 'GET reads' : 'the method and the last segment'})` };

  let aggregateOrigin: Explanation['aggregateOrigin'];
  if (meta.aggregate) aggregateOrigin = { origin: 'declared', detail: `the code declares the aggregate ${meta.aggregate}` };
  else if (meta.path && aggregateFromEndpoint({ ...meta, owner: undefined }) === candidate.aggregate && /[a-z]s(\/|$|\{)/i.test(meta.path.replace(/\{[^}]+\}/g, ''))) aggregateOrigin = { origin: 'path', detail: `the last collection in ${meta.path}` };
  else if (meta.owner) aggregateOrigin = { origin: 'owner', detail: `the class ${meta.owner}` };
  else aggregateOrigin = { origin: 'first-segment', detail: `the first business segment of ${meta.path}` };

  const tests = chain.filter(l => l.role === 'test');
  const hasCode = endpoints.some(e => e.extractor !== 'openapi');
  const hasContract = endpoints.some(e => e.extractor === 'openapi');
  const reason = tests.length ? `a test calls ${meta.method} ${meta.path} (${tests.map(t => `${t.file}:${t.line}`).join(', ')})`
    : hasCode && hasContract ? 'the code and the OpenAPI document agree on the endpoint'
    : candidate.confidence === 'strong' ? 'read directly from the syntax tree; no test or contract confirms it'
    : candidate.confidence === 'inferred' ? 'part of it is deduced from conventions (for example a default status)'
    : 'not enough evidence';

  const endpoint = `${candidate.operation.method} ${candidate.operation.path}`;
  return {
    operation: candidate.operation.name,
    type: candidate.operation.type,
    aggregate: candidate.aggregate,
    endpoint,
    name,
    aggregateOrigin,
    confidence: { level: candidate.confidence, reason },
    chain,
    scenarios: candidate.scenarios.map(s => ({ name: s.name, category: s.category, confidence: s.confidence, steps: s.steps.map(st => ({ keyword: st.keyword, text: st.text, evidence: st.evidence })) })),
    openQuestions: unresolved.filter(u => u.endpoint === endpoint).map(u => u.question)
  };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export type Decision = 'approve' | 'reject';

export interface ReviewDecision {
  decision: Decision;
  note?: string;
  /** Hash of the evidence ids the decision was made on. */
  evidence: string;
}

export interface ReviewFile {
  version: 1;
  /** `<Operation>|<scenario name>` → decision. */
  decisions: Record<string, ReviewDecision>;
}

export const scenarioKey = (c: BehaviorCandidate, s: ScenarioCandidate) => `${c.operation.name}|${s.name}`;
export const evidenceFingerprint = (s: ScenarioCandidate) => createHash('sha1').update([...new Set(s.steps.flatMap(st => st.evidence))].sort().join(',')).digest('hex').slice(0, 12);

export function readReview(root: string, dir: string): ReviewFile {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, dir, REVIEW_FILE), 'utf8'));
    if (data?.version === 1 && data.decisions && typeof data.decisions === 'object') return data as ReviewFile;
  } catch { /* no review yet */ }
  return { version: 1, decisions: {} };
}

export type ScenarioStatus = 'approved' | 'rejected' | 'stale' | 'pending';

export function scenarioStatus(review: ReviewFile, c: BehaviorCandidate, s: ScenarioCandidate): ScenarioStatus {
  const d = review.decisions[scenarioKey(c, s)];
  if (!d) return 'pending';
  if (d.evidence !== evidenceFingerprint(s)) return 'stale';
  return d.decision === 'approve' ? 'approved' : 'rejected';
}

/**
 * A selector names scenarios: `@PlaceOrder` (every scenario of the operation), a scenario name, or `all`.
 * Returns the keys it matches within the given candidates.
 */
export function selectScenarios(candidates: BehaviorCandidate[], selector: string): { candidate: BehaviorCandidate; scenario: ScenarioCandidate }[] {
  const s = selector.trim().toLowerCase();
  const out: { candidate: BehaviorCandidate; scenario: ScenarioCandidate }[] = [];
  for (const c of candidates) for (const sc of c.scenarios) {
    if (s === 'all' || (s.startsWith('@') && c.operation.name.toLowerCase() === s.slice(1)) || sc.name.toLowerCase() === s) out.push({ candidate: c, scenario: sc });
  }
  return out;
}

export function applyDecisions(review: ReviewFile, candidates: BehaviorCandidate[], selectors: { decision: Decision; selector: string }[], note?: string): { review: ReviewFile; changed: string[]; unmatched: string[] } {
  const next: ReviewFile = { version: 1, decisions: { ...review.decisions } };
  const changed: string[] = [];
  const unmatched: string[] = [];
  for (const { decision, selector } of selectors) {
    const hits = selectScenarios(candidates, selector);
    if (!hits.length) { unmatched.push(selector); continue; }
    for (const { candidate, scenario } of hits) {
      const key = scenarioKey(candidate, scenario);
      next.decisions[key] = { decision, ...(note ? { note } : {}), evidence: evidenceFingerprint(scenario) };
      changed.push(key);
    }
  }
  next.decisions = Object.fromEntries(Object.entries(next.decisions).sort(([a], [b]) => a.localeCompare(b)));
  return { review: next, changed: [...new Set(changed)], unmatched };
}

/** With a review on file, only approved (and not stale) scenarios are accepted. */
export function approvedOnly(review: ReviewFile, candidates: BehaviorCandidate[]): { candidates: BehaviorCandidate[]; left: { key: string; status: ScenarioStatus }[] } {
  const left: { key: string; status: ScenarioStatus }[] = [];
  const kept = candidates.map(c => ({
    ...c,
    scenarios: c.scenarios.filter(s => {
      const st = scenarioStatus(review, c, s);
      if (st !== 'approved') left.push({ key: scenarioKey(c, s), status: st });
      return st === 'approved';
    })
  })).filter(c => c.scenarios.length);
  return { candidates: kept, left };
}

export interface CodeExcerpt {
  file: string;
  from: number;
  to: number;
  lines: string[];
}

/** A few lines around an evidence location, secrets redacted; undefined when the file cannot be read. */
export function codeExcerpt(root: string, e: SourceEvidence, context = 3): CodeExcerpt | undefined {
  const file = path.resolve(root, e.location.file);
  if (!file.startsWith(path.resolve(root) + path.sep)) return undefined;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  const all = text.split(/\r?\n/);
  const from = Math.max(1, e.location.startLine - context);
  const to = Math.min(all.length, e.location.endLine + context);
  return { file: e.location.file, from, to, lines: all.slice(from - 1, to).map(l => redactSensitive(l)) };
}

export interface ReviewReport {
  proposals: {
    aggregate: string;
    scenarios: {
      operation: string;
      name: string;
      confidence: EvidenceConfidence;
      status: ScenarioStatus;
      note?: string;
      steps: { keyword: string; text: string; evidence: { id: string; file: string; line: number; excerpt?: CodeExcerpt }[] }[];
    }[];
  }[];
  openQuestions: { endpoint?: string; question: string }[];
  counts: Record<ScenarioStatus, number>;
}

export function buildReviewReport(root: string, candidates: BehaviorCandidate[], evidence: SourceEvidence[], review: ReviewFile, unresolved: { endpoint?: string; question: string }[], options: { aggregates?: string[]; context?: number; excerpts?: boolean } = {}): ReviewReport {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const wanted = (options.aggregates ?? []).map(a => a.toLowerCase());
  const selected = wanted.length ? candidates.filter(c => wanted.includes(c.aggregate.toLowerCase())) : candidates;
  const counts: Record<ScenarioStatus, number> = { approved: 0, rejected: 0, stale: 0, pending: 0 };
  const byAggregate = new Map<string, ReviewReport['proposals'][number]['scenarios']>();
  for (const c of [...selected].sort((a, b) => a.aggregate.localeCompare(b.aggregate) || a.operation.path.localeCompare(b.operation.path) || a.operation.method.localeCompare(b.operation.method))) {
    const list = byAggregate.get(c.aggregate) ?? [];
    for (const s of c.scenarios) {
      const status = scenarioStatus(review, c, s);
      counts[status]++;
      list.push({
        operation: c.operation.name, name: s.name, confidence: s.confidence, status,
        note: review.decisions[scenarioKey(c, s)]?.note,
        steps: s.steps.map(st => ({
          keyword: st.keyword, text: st.text,
          evidence: st.evidence.map(id => byId.get(id)).filter((e): e is SourceEvidence => Boolean(e)).map(e => ({
            id: e.id, file: e.location.file, line: e.location.startLine,
            ...(options.excerpts === false ? {} : { excerpt: codeExcerpt(root, e, options.context ?? 3) })
          }))
        }))
      });
    }
    byAggregate.set(c.aggregate, list);
  }
  const endpoints = new Set(selected.map(c => `${c.operation.method} ${c.operation.path}`));
  return {
    proposals: [...byAggregate.entries()].map(([aggregate, scenarios]) => ({ aggregate, scenarios })),
    openQuestions: unresolved.filter(u => !u.endpoint || endpoints.has(u.endpoint)),
    counts
  };
}
