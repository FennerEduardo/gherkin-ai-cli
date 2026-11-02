/* ==========================================================================
   gherkin-ai-cli - Source Evidence IR (SEIR) for `ghk reverse`

   Facts found in the implementation, each with where it was found, which
   analyzer found it and how sure that analyzer is. The evidence is not a
   requirement: it records what the code does today. Behaviour candidates and
   the proposed features are built from it, and every scenario step of a
   proposal points back to the evidence that supports it (PLAN-3.3.0 R-01).
   ========================================================================== */

import crypto from 'crypto';

export type EvidenceKind =
  | 'http-endpoint'
  | 'input-contract'
  | 'validation-rule'
  | 'authorization-rule'
  | 'service-call'
  | 'repository-query'
  | 'entity'
  | 'state-value'
  | 'domain-event'
  | 'error-condition'
  | 'success-response'
  | 'test-case';

/**
 * How the evidence is known, highest first (PLAN-3.3.0 §2, GPT design §6.2):
 * - confirmed: a test or an explicit contract (OpenAPI) agrees with the code;
 * - strong: read directly from the syntax tree and resolved;
 * - inferred: deduced from names or indirect relations;
 * - unknown: not enough evidence; reported as an open question, never as a step.
 * No percentages: nothing has calibrated them.
 */
export type EvidenceConfidence = 'confirmed' | 'strong' | 'inferred' | 'unknown';

export const CONFIDENCE_ORDER: EvidenceConfidence[] = ['confirmed', 'strong', 'inferred', 'unknown'];

export const atLeast = (c: EvidenceConfidence, min: EvidenceConfidence) => CONFIDENCE_ORDER.indexOf(c) <= CONFIDENCE_ORDER.indexOf(min);

export interface SourceLocationRange {
  /** Path relative to the analysed root, with forward slashes. */
  file: string;
  startLine: number;
  endLine: number;
}

export interface SourceEvidence {
  id: string;
  kind: EvidenceKind;
  symbol?: string;
  description: string;
  location: SourceLocationRange;
  /** The analyzer id that produced it (`typescript/express`, `openapi`, …). */
  extractor: string;
  confidence: EvidenceConfidence;
  /** Ids of related evidence; behaviour inside a handler references its endpoint. */
  references: string[];
  metadata?: Record<string, unknown>;
}

/** Endpoint metadata kept on `http-endpoint` evidence. */
export type EndpointMetadata = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Normalised path: `{id}` parameters, no trailing slash. */
  path: string;
  /** The handler's own name when it has one (`placeOrder`, `OrdersController.cancel`). */
  handler?: string;
  /** The controller or router class, when there is one. */
  owner?: string;
  operationId?: string;
  /** A command name the code declares outright (gherkin-ai kernel, CQRS command classes): used as is. */
  command?: string;
  /** An aggregate name the code declares outright (`ghk:implements Order`). */
  aggregate?: string;
};

/** Stable id: the same fact found again gets the same id, so two runs produce identical output. */
export function evidenceId(kind: EvidenceKind, file: string, line: number, key: string): string {
  return `ev-${crypto.createHash('sha1').update(`${kind}|${file}|${line}|${key}`).digest('hex').slice(0, 10)}`;
}

export function makeEvidence(e: Omit<SourceEvidence, 'id' | 'references'> & { references?: string[]; key?: string }): SourceEvidence {
  const { key, ...rest } = e;
  return {
    ...rest,
    id: evidenceId(e.kind, e.location.file, e.location.startLine, key ?? `${e.symbol ?? ''}|${e.description}`),
    references: [...new Set(e.references ?? [])].sort()
  };
}

/** Express and NestJS write `:id`, Spring `{id}`, FastAPI `{id}`; proposals and contracts use `{id}`. */
export function normalisePath(raw: string): string {
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  // Django/Flask `<int:pk>` first, so its `:pk` is not read as an Express `:param`.
  p = p.replace(/\/+/g, '/').replace(/<(?:\w+:)?(\w+)>/g, '{$1}').replace(/:([A-Za-z_][\w]*)/g, '{$1}');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

export function joinPaths(prefix: string | undefined, sub: string | undefined): string {
  return normalisePath(`${prefix ?? ''}/${sub ?? ''}`);
}

/** Deterministic order: file, line, kind, id. */
export function sortEvidence(list: SourceEvidence[]): SourceEvidence[] {
  return [...list].sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.startLine - b.location.startLine || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Drops exact duplicates (same id) keeping the highest confidence and the union of references. */
export function dedupeEvidence(list: SourceEvidence[]): SourceEvidence[] {
  const byId = new Map<string, SourceEvidence>();
  for (const e of list) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    const best = atLeast(e.confidence, prev.confidence) ? e : prev;
    byId.set(e.id, { ...best, references: [...new Set([...prev.references, ...e.references])].sort() });
  }
  return sortEvidence([...byId.values()]);
}
