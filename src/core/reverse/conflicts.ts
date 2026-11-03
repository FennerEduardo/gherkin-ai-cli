/* ==========================================================================
   gherkin-ai-cli - Tests that contradict the code (`ghk reverse`,
   PLAN-3.3.0-reverse-plus RV-09)

   A test is the strongest evidence there is, but a test can be stale. Three
   contradictions are reported in .ghe/reverse/conflicts.json, and the
   scenarios they touch drop to `inferred`, because neither side can be
   trusted until a person decides:
   - status: the test expects a success status the code never declares for that
     endpoint (201 in the test, 200 in the code). Failure statuses are not
     compared: security filters and global handlers produce them;
   - route: the test calls an endpoint the code does not expose;
   - event: the test names an event no code publishes.
   ========================================================================== */

import { isInfrastructureEndpoint, type BehaviorCandidate } from './candidates';
import { pathMatchesTemplate } from './analyzers/shared/body-text';
import { eventName } from './analyzers/typescript/ts-body';
import type { SourceEvidence } from './evidence';

export interface Conflict {
  kind: 'status' | 'route' | 'event';
  test: string;
  /** file:line of the test. */
  at: string;
  endpoint?: string;
  operation?: string;
  expected?: string;
  found?: string;
  message: string;
  evidence: string[];
}

export function findConflicts(evidence: SourceEvidence[], candidates: BehaviorCandidate[]): Conflict[] {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const tests = evidence.filter(e => e.kind === 'test-case');
  const http = candidates.filter(c => /^(GET|POST|PUT|PATCH|DELETE)$/.test(c.operation.method));
  const published = new Set(evidence.filter(e => e.kind === 'domain-event').flatMap(e => [String((e.metadata as any)?.event ?? ''), String((e.metadata as any)?.channel ?? '')]).filter(Boolean).map(s => eventName(s).toLowerCase()));
  // Consumed events are not a contradiction: a test may send one to a handler.
  const consumed = new Set(evidence.filter(e => e.kind === 'message-handler').map(e => eventName(String((e.metadata as any)?.channel ?? '')).toLowerCase()));
  const out: Conflict[] = [];
  const endpointPaths = http.map(c => c.operation.path);
  for (const t of tests) {
    const m = (t.metadata ?? {}) as { method: string; path: string; test?: string; expectedStatus?: number; events?: string[] };
    // gherkin-ai's own contract tests come from the features, not from the team; platform routes are not operations.
    if (/(^|\/)generated-specs\//.test(t.location.file) || isInfrastructureEndpoint(m.path)) continue;
    const at = `${t.location.file}:${t.location.startLine}`;
    const name = m.test ?? 'a test';
    const target = http.find(c => c.operation.method === m.method && pathMatchesTemplate(c.operation.path, m.path));
    if (!target) {
      // Only when the code has endpoints at all (a test of another service's API is not about this code), and not
      // for a parent collection of an endpoint the code has (`GET /institutions` next to `/institutions/{id}/grades`),
      // which is often a call to the service the test stubs.
      const parent = endpointPaths.some(p => p.replace(/\{[^}]+\}/g, '{}').startsWith(`${m.path.replace(/\{[^}]+\}/g, '{}')}/`));
      if (http.length && !parent) out.push({ kind: 'route', test: name, at, expected: `${m.method} ${m.path}`, message: `${name} (${at}) calls ${m.method} ${m.path}, which the code does not expose.`, evidence: [t.id] });
      continue;
    }
    const endpoint = `${target.operation.method} ${target.operation.path}`;
    // Only success statuses are compared, and only against one the code states outright (not a framework default):
    // failure statuses are often produced by security filters and global exception handlers the analyzers do not read.
    const declared = [...new Set(target.scenarios.flatMap(s => s.steps.flatMap(st => st.evidence)).map(id => byId.get(id)).filter(e => e?.kind === 'success-response' && e.confidence !== 'inferred').map(e => (e!.metadata as any).status as number))];
    if (m.expectedStatus !== undefined && m.expectedStatus < 400 && declared.length) {
      // A replay or a second call may legitimately return another success status (202 then 200): only a test whose
      // expected status no success path of the code declares, and which is not about a replay, contradicts it.
      if (!declared.includes(m.expectedStatus) && !/replay|idempot|again|twice|duplicate/i.test(name)) {
        const found = declared.sort((a, b) => a - b).join(', ');
        out.push({
          kind: 'status', test: name, at, endpoint, operation: target.operation.name, expected: String(m.expectedStatus), found,
          message: `${name} (${at}) expects ${m.expectedStatus} from ${endpoint}; the code returns ${found}.`,
          evidence: [t.id, ...target.endpointEvidence]
        });
      }
    }
    for (const ev of m.events ?? []) {
      const key = eventName(ev).toLowerCase();
      if (published.has(key) || consumed.has(key)) continue;
      out.push({ kind: 'event', test: name, at, endpoint, operation: target.operation.name, expected: ev, message: `${name} (${at}) names the event "${ev}", which no code publishes.`, evidence: [t.id] });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || (a.expected ?? '').localeCompare(b.expected ?? ''));
}

/** The scenarios of an operation in conflict drop to `inferred`: neither the test nor the code is trusted yet. */
export function applyConflicts(candidates: BehaviorCandidate[], conflicts: Conflict[]): void {
  const touched = new Set(conflicts.map(c => c.operation).filter(Boolean));
  for (const c of candidates) {
    if (!touched.has(c.operation.name)) continue;
    for (const s of c.scenarios) if (s.confidence === 'confirmed' || s.confidence === 'strong') s.confidence = 'inferred';
    c.confidence = c.scenarios[0]?.confidence ?? c.confidence;
  }
}
