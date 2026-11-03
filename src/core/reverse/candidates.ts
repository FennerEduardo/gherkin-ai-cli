/* ==========================================================================
   gherkin-ai-cli - Behaviour candidates for `ghk reverse` (PLAN-3.3.0 R-13)

   Groups the evidence into use cases: one candidate per endpoint (the same
   method + path found by several analyzers is one endpoint), its aggregate,
   the command or query it performs, and the scenarios the evidence supports:
   - one success scenario (what the response, the state and the events show);
   - one failure scenario per business condition (validation, authorization,
     not found, conflict…). Technical conditions (5xx) are never scenarios.
   Every step carries the ids of the evidence behind it; a Then without
   evidence is not written, it becomes an open question instead.
   ========================================================================== */

import type { EndpointMetadata, EvidenceConfidence, SourceEvidence } from './evidence';
import { CONFIDENCE_ORDER, atLeast } from './evidence';
import { EXTENDED_VERB_PATTERNS, VERB_PATTERNS } from '../ir/patterns';
import { toSnake } from '../../utils/naming';
import { pathMatchesTemplate } from './analyzers/shared/body-text';

export interface ProposedStep {
  keyword: 'Given' | 'When' | 'Then' | 'And';
  text: string;
  evidence: string[];
  /** A DataTable under the step: the request's fields and their rules, read from the code (RV-07). No values. */
  table?: string[][];
}

/** The Examples of a Scenario Outline: one row per case, each with the evidence behind it (RV-07). */
export interface ScenarioExamples {
  header: string[];
  rows: { cells: string[]; evidence: string[] }[];
}

export type ScenarioKind = 'happy-path' | 'validation' | 'authorization' | 'error-handling';

export interface ScenarioCandidate {
  name: string;
  category: ScenarioKind;
  steps: ProposedStep[];
  confidence: EvidenceConfidence;
  /** Present when the scenario is a Scenario Outline. */
  examples?: ScenarioExamples;
}

export interface BehaviorCandidate {
  id: string;
  aggregate: string;
  operation: { type: 'command' | 'query'; name: string; method: string; path: string; phrase: string };
  endpointEvidence: string[];
  extractors: string[];
  scenarios: ScenarioCandidate[];
  events: string[];
  confidence: EvidenceConfidence;
}

export interface UnresolvedQuestion {
  endpoint?: string;
  question: string;
  evidence: string[];
}

export interface CandidateResult {
  candidates: BehaviorCandidate[];
  unresolved: UnresolvedQuestion[];
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const VERBS = new Set([...Object.keys(VERB_PATTERNS), ...Object.keys(EXTENDED_VERB_PATTERNS),
  'get', 'list', 'retrieve', 'find', 'fetch', 'register', 'enroll', 'initiate', 'execute', 'link', 'unlink', 'set', 'add', 'remove', 'mark', 'notify', 'capture', 'evaluate', 'provide', 'change', 'save', 'edit', 'replace', 'patch', 'put', 'post', 'upsert', 'generate', 'sync', 'count', 'check', 'validate', 'login', 'logout', 'refresh',
  // Verbs of jobs and reactions (PLAN-3.3.0-reverse-plus RV-06).
  'purge', 'release', 'expire', 'close', 'remind', 'reconcile', 'settle', 'charge', 'refund', 'renew', 'import', 'export', 'clean', 'recalculate',
  'rotate', 'deliver', 'dispatch', 'reserve', 'invoice', 'bill', 'escalate', 'publish', 'index', 'backfill', 'calculate', 'compute']);
/** Handler names that are verbs of HTTP or CRUD plumbing rather than business verbs. */
const PLUMBING: Record<string, string> = { post: 'create', put: 'update', patch: 'update', upsert: 'update', save: 'create', store: 'create', destroy: 'delete', remove: 'delete', index: 'list', show: 'get', findAll: 'list', findOne: 'get', getAll: 'list', getOne: 'get', fetch: 'get', retrieve: 'get' };
const IGNORED_SEGMENTS = /^(api|apis|v\d+|rest|public|internal|admin|private|\{[^}]+\})$/i;

const pascal = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
/** Lower-case words of an identifier, split the way the generator splits them (`YRenderizado` → y, renderizado). */
const words = (pascalName: string) => toSnake(pascalName).split('_');

export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(word)) return word;
  // addresses → address, statuses → status, boxes → box, matches → match; courses → course, cases → case.
  if (/(sses|uses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
}

/** Third person singular: place → places, cancel → cancels, approve → approves, apply → applies. */
export function thirdPerson(verb: string): string {
  if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh|o)$/.test(verb)) return verb + 'es';
  return verb + 's';
}

const IRREGULAR: Record<string, string> = { send: 'sent', pay: 'paid', get: 'retrieved', set: 'set', put: 'put', buy: 'bought', sell: 'sold', find: 'found', hold: 'held', run: 'run', begin: 'begun', give: 'given', take: 'taken', write: 'written', make: 'made', build: 'built', login: 'logged in', logout: 'logged out', list: 'listed' };

/** Past participle: place → placed, cancel → cancelled, submit → submitted, apply → applied. */
export function participle(verb: string): string {
  if (IRREGULAR[verb]) return IRREGULAR[verb];
  if (verb.endsWith('e')) return verb + 'd';
  if (/[^aeiou]y$/.test(verb)) return verb.slice(0, -1) + 'ied';
  if (/^(cancel|label|model|travel|signal|total|fuel|level)$/.test(verb)) return verb + 'led';
  if (/^(submit|commit|admit|permit|omit|transmit|refer|prefer|transfer|occur|ship|stop|plan|drop|tag|map|grab|bar)$/.test(verb)) return verb + verb.slice(-1) + 'ed';
  return verb + 'ed';
}

/** "an order", "a user", "a unique id", "an hour" is not handled (no silent h in business nouns seen so far). */
const article = (noun: string) => (/^(u[sn]i|use|usu|uti|ura|ure|eu|one\b)/i.test(noun) ? 'a' : /^[aeiou]/i.test(noun) ? 'an' : 'a');
/** Leading prepositions of a handler name are not part of the object: `unsubscribeFromUser` → user. */
const PREPOSITIONS = /^(from|to|by|for|of|on|in|into|with|at)$/;
/** A message taken from code that is really code (`&& errors.Is(err, …) {`), not prose, is not quoted or used in a name. */
export function isProse(message: string | undefined): message is string {
  return Boolean(message) && !/[{}();=&|<>]|=>|\b(err|nil|null|undefined|return|if)\b\s*[!=.(]/.test(message!) && message!.length <= 120;
}

/** Plural words that are not collections. */
const NOT_COLLECTIONS = /^(status|address|access|process|class|alias|news|series|canvas|bus|campus|terms|settings|details|options|analytics|metrics)$/i;

/**
 * The resource a nested path acts on: the last collection (a plural segment) of `/institutions/{id}/members`,
 * `/courses/{id}/assignments`, `/orders/{id}/cancel`. Undefined when the path has no plural segment.
 */
export function resourceFromPath(p: string): string | undefined {
  const literals = p.split('/').filter(s => s && !IGNORED_SEGMENTS.test(s));
  for (let i = literals.length - 1; i >= 0; i--) {
    const seg = literals[i].replace(/[^A-Za-z0-9-]+/g, '');
    const last = seg.split('-').pop() ?? seg;
    if (/[a-z]s$/i.test(last) && !/ss$/i.test(last) && !NOT_COLLECTIONS.test(last)) return pascal(seg.split('-').slice(0, -1).concat(singular(last)).join(' '));
  }
  return undefined;
}

export function aggregateFromEndpoint(meta: EndpointMetadata): string {
  if (meta.aggregate) return meta.aggregate;
  // The path names the resource (`LearningController` serves /courses/{id}/assignments and /assignments/{id}/submissions).
  const resource = resourceFromPath(meta.path);
  if (resource) return resource;
  if (meta.owner && /Controller$|Resource$|Router$|Routes$|Handler$|Api$/.test(meta.owner)) {
    const base = meta.owner.replace(/(Controller|Resource|Router|Routes|Handler|Api)$/, '');
    if (base) return pascal(singular(pascal(base)));
  }
  const seg = meta.path.split('/').filter(Boolean).find(s => !IGNORED_SEGMENTS.test(s));
  return seg ? pascal(singular(seg.replace(/[^A-Za-z0-9]+/g, ' '))) : 'Api';
}

export function operationName(meta: EndpointMetadata, aggregate: string, operationId?: string): { name: string; type: 'command' | 'query'; verb: string } {
  const type: 'command' | 'query' = meta.method === 'GET' ? 'query' : 'command';
  if (meta.command) return { name: meta.command, type: 'command', verb: words(meta.command)[0] };
  const fromName = (raw: string) => {
    const leaf = raw.split('.').pop()!;
    const w = words(pascal(leaf));
    const verb = PLUMBING[leaf] ?? PLUMBING[w[0]] ?? w[0];
    if (!VERBS.has(verb) && !PLUMBING[leaf]) return undefined;
    const rest = PLUMBING[leaf] ? [] : w.slice(1);
    while (rest.length && PREPOSITIONS.test(rest[0])) rest.shift();
    const noun = rest.length ? pascal(rest.join(' ')) : (verb === 'list' ? plural(aggregate) : aggregate);
    return { name: pascal(verb) + noun, type: (verb === 'get' || verb === 'list' || verb === 'search' || verb === 'find' || verb === 'count') ? 'query' as const : type, verb };
  };
  const named = (operationId && fromName(operationId)) || (meta.handler && fromName(meta.handler));
  const segs = meta.path.split('/').filter(Boolean);
  // A handler called just `Get` on a collection (`GET /articles`, ASP.NET) lists it; on an item it gets one.
  if (named && named.verb === 'get' && named.name === `Get${aggregate}` && meta.method === 'GET' && !/^\{/.test(segs[segs.length - 1] ?? '')) return { name: `List${plural(aggregate)}`, type: 'query', verb: 'list' };
  if (named) return named;
  const last = segs[segs.length - 1] ?? '';
  const onItem = /^\{/.test(last);
  if (meta.method === 'GET') return onItem ? { name: `Get${aggregate}`, type, verb: 'get' } : { name: `List${plural(aggregate)}`, type, verb: 'list' };
  if (meta.method === 'DELETE') return { name: `Delete${aggregate}`, type, verb: 'delete' };
  if (meta.method === 'PUT' || meta.method === 'PATCH') return { name: `Update${aggregate}`, type, verb: 'update' };
  // POST /orders/{id}/cancel → CancelOrder; POST /payments/{id}/settle → SettlePayment (the word after the id is
  // the action by REST convention, known verb or not); POST /orders → CreateOrder.
  // A plural or hyphenated segment is a sub-collection (POST /institutions/{id}/members → create), not an action.
  const action = !onItem && segs.length > 1 && /^\{/.test(segs[segs.length - 2] ?? '') && /^[a-z]{3,}$/i.test(last) ? last.toLowerCase() : '';
  const isCollection = /[a-z]s$/.test(action) && !/ss$/.test(action) && !NOT_COLLECTIONS.test(action);
  if (action && !isCollection && !/^(item|line|detail|status|history|event|children|configuration|settings|profile)$/.test(action)) return { name: pascal(action) + aggregate, type, verb: action };
  // POST /users/login, POST /orders/validate: a trailing known verb is the action, with or without an id before it.
  const trailing = last.toLowerCase();
  if (!onItem && segs.length > 1 && VERBS.has(trailing) && !PLUMBING[trailing] && !['get', 'list', 'find', 'count'].includes(trailing)) return { name: pascal(trailing) + aggregate, type, verb: trailing };
  return { name: `Create${aggregate}`, type, verb: 'create' };
}

/** "places an order", "cancels the order", "lists the orders". */
export function operationPhrase(name: string, verb: string, onItem: boolean): string {
  const w = words(name);
  const objectWords = w.slice(verb.split(' ').length);
  const object = objectWords.join(' ');
  if (verb === 'list') return `lists the ${object}`;
  if (verb === 'get') return `retrieves the ${object}`;
  const det = onItem ? 'the' : article(object);
  return `${thirdPerson(verb)} ${object ? `${det} ${object}` : 'the request'}`;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Health probes, metrics and API documentation: operations of the platform, not of the business. */
const INFRASTRUCTURE_SEGMENTS = /^(health|healthz|healthcheck|live|livez|liveness|ready|readyz|readiness|ping|metrics|prometheus|actuator|status|version|info|swagger|swagger-ui|docs|api-docs|openapi|openapi\.json|favicon\.ico|robots\.txt)$/i;
export function isInfrastructureEndpoint(p: string): boolean {
  const seg = p.split('/').filter(Boolean).find(s => !IGNORED_SEGMENTS.test(s));
  return seg !== undefined && INFRASTRUCTURE_SEGMENTS.test(seg);
}

const endpointKey = (m: { method: string; path: string }) => `${m.method} ${m.path.replace(/\{[^}]+\}/g, '{}')}`;

function maxConfidence(list: EvidenceConfidence[]): EvidenceConfidence {
  return list.reduce<EvidenceConfidence>((best, c) => (atLeast(c, best) ? c : best), 'unknown');
}
function minConfidence(list: EvidenceConfidence[]): EvidenceConfidence {
  return list.reduce<EvidenceConfidence>((worst, c) => (CONFIDENCE_ORDER.indexOf(c) > CONFIDENCE_ORDER.indexOf(worst) ? c : worst), 'confirmed');
}

interface Failure {
  status?: number;
  message?: string;
  condition?: string;
  field?: string;
  rule?: string;
  /** The rule's argument as written (`50` in `@MaxLength(50)`). */
  param?: string;
  roles?: string[];
  kind: SourceEvidence['kind'];
  evidence: SourceEvidence[];
}

/** `order.status !== 'PENDING'` → PENDING (the state the success path requires). */
export function requiredState(condition: string | undefined): string | undefined {
  // The value may be a literal ('PENDING') or an enum member (OrderStatus.PENDING): keep the last segment.
  const m = condition?.match(/\b(?:status|state)\s*!==?\s*['"`]?([A-Za-z][\w.-]*)['"`]?/i) ?? condition?.match(/['"`]?([A-Za-z][\w.-]*)['"`]?\s*!==?\s*[\w.]*\b(?:status|state)\b/i);
  return m?.[1]?.split('.').pop();
}

function failureScenario(f: Failure, ctx: { aggregate: string; noun: string; phrase: string; when: ProposedStep; givenItem?: ProposedStep; auth?: ProposedStep }): ScenarioCandidate | undefined {
  const ids = f.evidence.map(e => e.id);
  const conf = maxConfidence(f.evidence.map(e => e.confidence));
  const steps: ProposedStep[] = [];
  const message = isProse(f.message) ? f.message : undefined;
  const quoted = message && message.length <= 80 ? `"${message.replace(/"/g, "'")}"` : undefined;
  let name: string;
  let category: ScenarioKind;
  let then: string;

  if (f.kind === 'authorization-rule') {
    category = 'authorization';
    const forbidden = f.status === 403 || (f.roles?.length ?? 0) > 0;
    steps.push({ keyword: 'Given', text: forbidden ? (f.roles?.length ? `a user without the "${f.roles.join('" or "')}" role` : 'a user without permission') : 'a user who is not signed in', evidence: ids });
    then = forbidden ? 'the request is denied as forbidden' : 'the request is denied as unauthorized';
    name = !forbidden ? `An unauthenticated user cannot ${baseForm(ctx.phrase)}`
      : f.roles?.length ? `A user without the ${f.roles.join(' or ')} role cannot ${baseForm(ctx.phrase)}`
      : `A user without permission cannot ${baseForm(ctx.phrase)}`;
  } else if (f.kind === 'validation-rule') {
    category = 'validation';
    if (ctx.auth) steps.push(ctx.auth);
    const field = f.field ? humanField(f.field) : '';
    const be = /s$/.test(field) ? 'are' : 'is';
    const what = f.field ? (f.rule === 'required' ? `${field} ${be} missing` : `${field} ${be} not ${ruleWords(f.rule, message)}`) : (message ? lowerFirst(message) : 'the input is invalid');
    // The validator names the field and the rule: the outcome says which, so each field's scenario is distinct (GHK004).
    then = quoted ? `the request is rejected because ${quoted}` : f.field ? `the request is rejected because the ${what}` : 'the request is rejected as invalid';
    name = `${capitalise(gerund(ctx.phrase))} is rejected when ${what}`;
  } else {
    category = 'error-handling';
    const state = requiredState(f.condition);
    if (ctx.auth) steps.push(ctx.auth);
    if (f.status === 404) steps.push({ keyword: 'Given', text: `${article(ctx.noun)} ${ctx.noun} that does not exist`, evidence: ids });
    else if (state) steps.push({ keyword: 'Given', text: `${article(ctx.noun)} ${ctx.noun} whose status is not "${state}"`, evidence: ids });
    else if (ctx.givenItem) steps.push(ctx.givenItem);
    const as = f.status === 404 ? 'not found' : f.status === 409 ? 'a conflict' : f.status === 412 ? 'a failed precondition' : f.status === 429 ? 'too many requests' : 'an error';
    then = quoted ? `the request fails because ${quoted}` : `the request fails as ${as}`;
    name = f.status === 404 ? `${capitalise(gerund(ctx.phrase))} fails when the ${ctx.noun} does not exist`
      : state ? `${capitalise(gerund(ctx.phrase))} fails when the ${ctx.noun} is not ${state.toLowerCase()}`
      : `${capitalise(gerund(ctx.phrase))} fails when ${message ? message.toLowerCase() : `the result is ${as}`}`;
  }
  steps.push({ ...ctx.when, keyword: 'When' });
  steps.push({ keyword: 'Then', text: then, evidence: ids });
  return { name: name.replace(/\s+/g, ' ').trim(), category, steps: normaliseKeywords(steps), confidence: conf };
}

/**
 * Validation of several fields as one Scenario Outline (RV-07): `Then the request is rejected because the <field>
 * is <problem>`, with a row per field and rule. Every cell comes from the code: the field name, the rule and its
 * limit (`@MaxLength(50)` → "not short enough (at most 50)"); nothing is invented.
 */
function validationOutline(failures: Failure[], ctx: { phrase: string; when: ProposedStep; auth?: ProposedStep }): ScenarioCandidate {
  const rows = failures
    .map(f => {
      const field = humanField(f.field!);
      const limit = typeof f.param === 'string' && /^\d+(\.\d+)?$/.test(f.param.trim()) ? f.param.trim() : undefined;
      const words = f.rule === 'required' ? 'missing' : `not ${ruleWords(f.rule, isProse(f.message) ? f.message : undefined)}`;
      const bound = limit && /^(min|minLength|length|minItems)$/.test(f.rule ?? '') ? ` (at least ${limit})` : limit && /^(max|maxLength)$/.test(f.rule ?? '') ? ` (at most ${limit})` : '';
      return { cells: [field, `${words}${bound}`], evidence: f.evidence.map(e => e.id).sort() };
    })
    .sort((a, b) => a.cells[0].localeCompare(b.cells[0]) || a.cells[1].localeCompare(b.cells[1]));
  // One row per field and problem (two analyzers may report the same rule).
  const unique = [...new Map(rows.map(r => [r.cells.join('|'), r])).values()];
  const steps: ProposedStep[] = [];
  if (ctx.auth) steps.push(ctx.auth);
  steps.push({ ...ctx.when, keyword: 'When' });
  steps.push({ keyword: 'Then', text: 'the request is rejected because the <field> is <problem>', evidence: [...new Set(unique.flatMap(r => r.evidence))].sort() });
  return {
    name: `${capitalise(gerund(ctx.phrase))} is rejected when a field is invalid`,
    category: 'validation',
    steps: normaliseKeywords(steps),
    confidence: maxConfidence(failures.flatMap(f => f.evidence.map(e => e.confidence))),
    examples: { header: ['field', 'problem'], rows: unique }
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "Command id is required" → "command id is required" (an acronym such as "IBAN is invalid" is kept). */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** "places an order" → "place an order", "processes" → "process", "applies" → "apply" (one rule only). */
export function baseForm(phrase: string): string {
  const [verb, ...rest] = phrase.split(' ');
  let base = verb;
  if (/[^aeiou]ies$/.test(verb)) base = verb.slice(0, -3) + 'y';
  else if (/(ss|x|z|ch|sh|o)es$/.test(verb)) base = verb.slice(0, -2);
  else if (/[^s]s$/.test(verb)) base = verb.slice(0, -1);
  return [base, ...rest].join(' ');
}
/** "places an order" → "placing an order". */
function gerund(phrase: string): string {
  const [verb, ...rest] = baseForm(phrase).split(' ');
  let g = verb;
  if (/ie$/.test(verb)) g = verb.slice(0, -2) + 'ying';
  else if (/[^e]e$/.test(verb)) g = verb.slice(0, -1) + 'ing';
  else if (/^(cancel|label|model|travel|signal|total)$/.test(verb)) g = verb + 'ling';
  else if (/^(submit|commit|admit|permit|transmit|refer|transfer|ship|stop|plan|drop|tag|map)$/.test(verb)) g = verb + verb.slice(-1) + 'ing';
  else g = verb + 'ing';
  return [g, ...rest].join(' ');
}
const humanField = (f: string) => f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
function ruleWords(rule: string | undefined, message?: string): string {
  switch (rule) {
    case 'email': return 'a valid email';
    case 'uuid': return 'a valid identifier';
    case 'min': case 'positive': return 'large enough';
    case 'max': return 'small enough';
    case 'minLength': case 'length': return 'long enough';
    case 'maxLength': return 'short enough';
    case 'minItems': return 'given at least one item';
    case 'integer': return 'a whole number';
    case 'enum': return 'one of the allowed values';
    case 'date': return 'a valid date';
    case 'pattern': return 'in the expected format';
    default: return message ? `valid (${message})` : 'valid';
  }
}

function normaliseKeywords(steps: ProposedStep[]): ProposedStep[] {
  const out: ProposedStep[] = [];
  let last: string | undefined;
  for (const s of steps) {
    const base = s.keyword === 'And' ? last : s.keyword;
    out.push({ ...s, keyword: base === last && out.length ? 'And' : (base as ProposedStep['keyword']) });
    last = base;
  }
  return out;
}

export function buildCandidates(evidence: SourceEvidence[]): CandidateResult {
  const byId = new Map(evidence.map(e => [e.id, e]));
  const endpoints = evidence.filter(e => e.kind === 'http-endpoint');
  const groups = new Map<string, SourceEvidence[]>();
  const candidates: BehaviorCandidate[] = [];
  const unresolved: UnresolvedQuestion[] = [];
  // A generic dispatcher (`POST /orders/{id}/{command}`) is not an operation: the commands behind it are
  // (the gherkin-ai kernel adapter lists them). Without them it is an open question.
  const isDispatcher = (m: EndpointMetadata) => /\/\{(command|action|operation|op)\}$/.test(m.path);
  const commandPaths = new Set(endpoints.filter(e => (e.metadata as any)?.command).map(e => (e.metadata as any).path.replace(/\/[^/]+$/, '')));
  for (const e of endpoints) {
    const meta = e.metadata as unknown as EndpointMetadata;
    if (isInfrastructureEndpoint(meta.path)) continue;
    if (isDispatcher(meta)) {
      const base = meta.path.replace(/\/\{[^}]+\}$/, '');
      if (!commandPaths.has(base)) unresolved.push({ endpoint: `${meta.method} ${meta.path}`, question: `${meta.method} ${meta.path} dispatches commands by name; which commands does it accept?`, evidence: [e.id] });
      continue;
    }
    const key = endpointKey(meta);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const tests = evidence.filter(e => e.kind === 'test-case');

  // Names first, for every endpoint, so two endpoints of one aggregate never share an operation name
  // (`DELETE /articles/{slug}` and `DELETE /articles/{slug}/favorite`, `GET /articles` and `GET /articles/feed`):
  // the longer path is told apart by the literal segments the shorter one does not have.
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    // The code adapter names things; the contract confirms. Prefer code metadata, keep the operationId.
    const code = group.find(e => e.extractor !== 'openapi') ?? group[0];
    const meta = { ...(code.metadata as unknown as EndpointMetadata) };
    const operationId = group.map(e => (e.metadata as any)?.operationId).find(Boolean) as string | undefined;
    const aggregate = aggregateFromEndpoint(meta);
    return { key, group, meta, operationId, aggregate, op: operationName(meta, aggregate, operationId) };
  });
  const byName = new Map<string, typeof entries>();
  for (const x of entries) byName.set(`${x.aggregate}|${x.op.name}`, [...(byName.get(`${x.aggregate}|${x.op.name}`) ?? []), x]);
  for (const same of byName.values()) {
    if (same.length < 2 || same.some(x => x.meta.command)) continue;
    const literals = (p: string) => p.split('/').filter(s => s && !IGNORED_SEGMENTS.test(s));
    const [first, ...rest] = [...same].sort((a, b) => a.meta.path.length - b.meta.path.length || a.meta.path.localeCompare(b.meta.path));
    const base = new Set(literals(first.meta.path).map(s => s.toLowerCase()));
    for (const x of rest) {
      const extra = pascal(literals(x.meta.path).filter(s => !base.has(s.toLowerCase())).join(' '));
      if (!extra) continue;
      const verbWord = pascal(x.op.verb);
      x.op = { ...x.op, name: x.op.verb === 'list' ? verbWord + extra + x.op.name.slice(verbWord.length) : x.op.name + extra };
    }
  }

  for (const { group, meta, aggregate, op } of entries) {
    const ids = new Set(group.map(e => e.id));
    const related = evidence.filter(e => e.references.some(r => ids.has(r)));
    // A test calls a concrete URL (`/orders/o-1/cancel`) or the template itself.
    const testHits = tests.filter(t => (t.metadata as any)?.method === meta.method && pathMatchesTemplate(meta.path, String((t.metadata as any)?.path ?? '')));
    const onItem = /\{[^}]+\}/.test(meta.path);
    const nounWords = words(op.name).slice(1).join(' ') || aggregate.toLowerCase();
    const noun = op.verb === 'list' ? singular(nounWords) : nounWords;
    const phrase = operationPhrase(op.name, op.verb, onItem);
    const hasCode = group.some(e => e.extractor !== 'openapi');
    const hasContract = group.some(e => e.extractor === 'openapi');
    const endpointConfidence: EvidenceConfidence = testHits.length || (hasCode && hasContract) ? 'confirmed' : maxConfidence(group.map(e => e.confidence));
    const endpointIds = group.map(e => e.id).sort();

    const auths = related.filter(e => e.kind === 'authorization-rule');
    const authStep: ProposedStep | undefined = auths.length ? { keyword: 'Given', text: 'a signed-in user', evidence: auths.map(a => a.id) } : undefined;
    const givenItem: ProposedStep | undefined = onItem && op.verb !== 'create' ? { keyword: 'Given', text: `an existing ${noun}`, evidence: endpointIds } : undefined;
    const when: ProposedStep = { keyword: 'When', text: `the user ${phrase}`, evidence: endpointIds };

    // Failures: business conditions only, the same status + message from several analyzers merged.
    const failures = new Map<string, Failure>();
    const addFailure = (e: SourceEvidence) => {
      const m = (e.metadata ?? {}) as any;
      if (m.technical) return;
      // One failure per field and rule: `quantity` that must be an integer and positive is two cases (RV-07).
      const k = e.kind === 'validation-rule' && m.field ? `field:${m.field}:${m.rule ?? ''}` : e.kind === 'authorization-rule' ? `auth:${m.status === 403 || m.roles ? 403 : 401}` : `status:${m.status ?? '?'}|${(m.message ?? m.condition ?? '').toLowerCase()}`;
      const prev = failures.get(k);
      if (prev) {
        prev.evidence.push(e);
        prev.message ??= m.message;
        prev.condition ??= m.condition;
        return;
      }
      // A documented status the code also raises (with a message) is the same failure: attach, don't duplicate.
      if (m.documented && e.kind !== 'validation-rule') {
        const same = [...failures.values()].find(f => f.status === m.status && f.kind === e.kind);
        if (same) { same.evidence.push(e); return; }
      }
      failures.set(k, { status: m.status, message: m.message, condition: m.condition, field: m.field, rule: m.rule, param: m.param, roles: m.roles, kind: e.kind, evidence: [e] });
    };
    // Code first, then the contract, so documented statuses attach to what the code raises.
    for (const e of related.filter(x => ['validation-rule', 'authorization-rule', 'error-condition'].includes(x.kind)).sort((a, b) => Number(a.extractor === 'openapi') - Number(b.extractor === 'openapi'))) addFailure(e);
    // A guarded auth check in the body (`if (!req.user) return 401`) and an auth middleware share the key `auth:401`: one scenario.

    // Success.
    const successResp = related.filter(e => e.kind === 'success-response');
    const states = related.filter(e => e.kind === 'state-value');
    const events = related.filter(e => e.kind === 'domain-event');
    const steps: ProposedStep[] = [];
    if (authStep) steps.push(authStep);
    const guard = [...failures.values()].map(f => requiredState(f.condition)).find(Boolean);
    if (guard) steps.push({ keyword: 'Given', text: `${article(noun)} ${noun} with status "${guard}"`, evidence: [...failures.values()].filter(f => requiredState(f.condition) === guard).flatMap(f => f.evidence.map(e => e.id)) });
    else if (givenItem) steps.push(givenItem);
    steps.push(when);
    const status = (successResp.find(e => e.extractor !== 'openapi') ?? successResp[0])?.metadata?.status as number | undefined;
    const successIds = successResp.map(e => e.id);
    if (op.type === 'query') {
      steps.push({ keyword: 'Then', text: op.verb === 'list' ? `the ${plural(noun)} are returned` : `the ${noun} is returned`, evidence: successIds.length ? successIds : endpointIds });
    } else if (successIds.length) {
      steps.push({ keyword: 'Then', text: status === 201 && op.verb === 'create' ? `the ${noun} is created` : `the ${noun} is ${participle(op.verb)}`, evidence: successIds });
    }
    const stateValues = new Map<string, string[]>();
    for (const s of states) {
      const v = String((s.metadata as any).value);
      stateValues.set(v, [...(stateValues.get(v) ?? []), s.id]);
    }
    // The state the operation leaves: the value written (or created with); a guard value is a precondition, not an outcome.
    for (const [value, evIds] of [...stateValues.entries()].filter(([v]) => v !== guard)) {
      steps.push({ keyword: 'Then', text: `the ${noun} status is "${value}"`, evidence: evIds });
    }
    const eventNames = new Map<string, string[]>();
    for (const e of events) {
      const n = String((e.metadata as any).event);
      eventNames.set(n, [...(eventNames.get(n) ?? []), e.id]);
    }
    for (const [n, evIds] of eventNames) steps.push({ keyword: 'Then', text: `the "${n}" event is published`, evidence: evIds });

    const scenarios: ScenarioCandidate[] = [];
    if (steps.some(s => s.keyword === 'Then')) {
      const successEvidence = steps.flatMap(s => s.evidence).map(id => byId.get(id)).filter((e): e is SourceEvidence => Boolean(e));
      const conf = endpointConfidence === 'confirmed' ? 'confirmed' : minConfidence([endpointConfidence, maxConfidence(successEvidence.filter(e => e.kind !== 'http-endpoint').map(e => e.confidence))]);
      scenarios.push({ name: capitalise(baseForm(phrase)), category: 'happy-path', steps: normaliseKeywords(steps), confidence: conf });
    } else {
      unresolved.push({ endpoint: `${meta.method} ${meta.path}`, question: `What does ${meta.method} ${meta.path} return or change? No response, state or event was found in the code.`, evidence: endpointIds });
    }
    // Validation of two or more fields: one Scenario Outline, a row per field and rule, each row with its evidence (RV-07).
    const fieldRules = [...failures.values()].filter(f => f.kind === 'validation-rule' && f.field);
    const outline = fieldRules.length >= 2 ? validationOutline(fieldRules, { phrase, when, auth: authStep }) : undefined;
    if (outline) scenarios.push(outline);
    for (const f of [...failures.values()].sort((a, b) => (a.status ?? 0) - (b.status ?? 0) || (a.field ?? '').localeCompare(b.field ?? ''))) {
      if (outline && fieldRules.includes(f)) continue;
      const sc = failureScenario(f, { aggregate, noun, phrase, when, givenItem, auth: f.kind === 'authorization-rule' ? undefined : authStep });
      if (sc) scenarios.push(sc);
    }
    // The request's fields under the success When, from the input contract the analyzers read (RV-07).
    const contract = related.find(e => e.kind === 'input-contract' && Array.isArray((e.metadata as any)?.fields) && (e.metadata as any).fields.length);
    const happy = scenarios.find(s => s.category === 'happy-path');
    if (contract && happy) {
      const fields = ((contract.metadata as any).fields as { name: string; rules?: string[] }[]).filter(f => /^[A-Za-z_][\w]*$/.test(f.name));
      const at = happy.steps.findIndex(s => s.keyword === 'When');
      if (fields.length && at >= 0) {
        happy.steps[at] = { ...happy.steps[at], text: `${happy.steps[at].text} with`, evidence: [...new Set([...happy.steps[at].evidence, contract.id])].sort(), table: [['field', 'rules'], ...fields.map(f => [f.name, [...new Set(f.rules ?? [])].join(', ') || '-'])] };
      }
    }
    // Failures that read the same (two validation errors without a field or a message) are one scenario with
    // the evidence of both, not two identical scenarios (GHK004).
    const bySteps = new Map<string, ScenarioCandidate>();
    for (const sc of [...scenarios]) {
      const k = sc.steps.map(s => `${s.keyword}:${s.text}`).join('|');
      const prev = bySteps.get(k);
      if (!prev) { bySteps.set(k, sc); continue; }
      prev.steps = prev.steps.map((s, i) => ({ ...s, evidence: [...new Set([...s.evidence, ...sc.steps[i].evidence])].sort() }));
      prev.confidence = maxConfidence([prev.confidence, sc.confidence]);
      scenarios.splice(scenarios.indexOf(sc), 1);
    }
    // Two scenarios must never share a name (GHK004).
    const seen = new Map<string, number>();
    for (const sc of scenarios) {
      const n = seen.get(sc.name) ?? 0;
      seen.set(sc.name, n + 1);
      if (n) sc.name = `${sc.name} (${n + 1})`;
    }
    for (const e of related.filter(x => (x.metadata as any)?.technical)) {
      unresolved.push({ endpoint: `${meta.method} ${meta.path}`, question: `Technical condition left out of the scenarios: ${e.description}. Is it observable behaviour?`, evidence: [e.id] });
    }

    candidates.push({
      id: `bc-${op.name}-${meta.method.toLowerCase()}`,
      aggregate,
      operation: { type: op.type, name: op.name, method: meta.method, path: meta.path, phrase },
      endpointEvidence: endpointIds,
      extractors: [...new Set([...group, ...related, ...testHits].map(e => e.extractor))].sort(),
      scenarios,
      events: [...eventNames.keys()],
      confidence: scenarios[0]?.confidence ?? 'unknown'
    });
  }
  candidates.push(...entryCandidates(evidence, unresolved));
  attachConstraintsAndIntegrations(candidates, evidence, unresolved);

  // Same operation name on two endpoints (two POSTs on one aggregate): keep both, disambiguate the second.
  const names = new Map<string, number>();
  for (const c of candidates) {
    const k = `${c.aggregate}|${c.operation.name}`;
    const n = names.get(k) ?? 0;
    names.set(k, n + 1);
    if (n) unresolved.push({ endpoint: `${c.operation.method} ${c.operation.path}`, question: `Two endpoints map to ${c.operation.name}; rename one of the proposals.`, evidence: c.endpointEvidence });
  }
  return { candidates, unresolved };
}

// ---------------------------------------------------------------------------
// Entry points that are not HTTP (PLAN-3.3.0-reverse-plus RV-06)
// ---------------------------------------------------------------------------

const ENTRY_SUFFIX = /(Listeners?|Handlers?|Consumers?|Subscribers?|Controllers?|Services?|Jobs?|Schedulers?|Tasks?|Workers?|Processors?|Projectors?|Sagas?|Polic(?:y|ies))$/;

/** `order.placed`, `orders.order-placed.v1`, `OrderPlaced` → OrderPlaced; `orders-queue` → OrdersQueue. */
export function channelName(channel: string): string {
  const parts = channel.split(/[./:]/).filter(s => s && !/^v\d+$/i.test(s));
  const tail = parts[parts.length - 1] ?? channel;
  const pick = parts.length > 1 && !/[-_]/.test(tail) ? parts.slice(-2) : [tail];
  return pascal(pick.join(' ').replace(/[-_]+/g, ' '));
}
const looksLikeEvent = (channel: string) => /(ed|Event)$/i.test(channel.split(/[./:]/).filter(Boolean).pop()?.split(/[-_]/).pop() ?? '');

/** The operation of a handler: its own name when it starts with a business verb, otherwise Handle<Event> / Run<Job>. */
export function entryOperation(meta: { trigger: 'message' | 'schedule'; channel?: string; handler?: string }, aggregate: string): { name: string; verb: string } {
  const handler = meta.handler?.split('.').pop();
  if (handler) {
    const w = words(pascal(handler));
    // `sendConfirmation` → SendConfirmation; a bare verb (`expire`) acts on the aggregate: ExpireSagaTimeout.
    if (VERBS.has(w[0]) && !/^(handle|process|consume|on|run|execute|receive)$/.test(w[0])) {
      const rest = w.slice(1);
      while (rest.length && PREPOSITIONS.test(rest[0])) rest.shift();
      return { name: pascal(w[0]) + (rest.length ? pascal(rest.join(' ')) : aggregate), verb: w[0] };
    }
  }
  if (meta.trigger === 'message' && meta.channel) return { name: `Handle${channelName(meta.channel)}`, verb: 'handle' };
  const base = pascal((handler ?? aggregate).replace(/^(run|execute)/i, ''));
  return { name: `Run${base}${/Job$/.test(base) ? '' : 'Job'}`, verb: 'run' };
}

/**
 * The aggregate a handler works on, most specific first:
 * 1. its class without the suffix (`StockListeners` → Stock), unless that is just the event's name
 *    (`OrderShippedConsumer`);
 * 2. the noun of a verb-first handler (`archiveDeliveredShipments` → Shipment);
 * 3. the first segment of the channel (`orders.order-paid` → Order).
 */
function entryAggregate(meta: { trigger: 'message' | 'schedule'; channel?: string; owner?: string; handler?: string }): string {
  const base = meta.owner?.replace(ENTRY_SUFFIX, '');
  const isEventName = Boolean(base && meta.channel && channelName(meta.channel) === base);
  if (base && base !== meta.owner && !isEventName) return pascal(singular(pascal(base)));
  const hw = meta.handler ? words(pascal(meta.handler.split('.').pop()!)) : [];
  if (hw.length > 1 && VERBS.has(hw[0]) && !/^(handle|process|consume|on|run|execute|receive)$/.test(hw[0])) return pascal(singular(hw[hw.length - 1]));
  if (meta.channel) {
    const first = meta.channel.split(/[./:_-]/).filter(Boolean)[0];
    if (first) return pascal(singular(isEventName ? words(base!)[0] : first));
  }
  return base ? pascal(singular(pascal(base))) : 'Job';
}

/**
 * Jobs and consumers of the platform, not of the business: the outbox relay, the inbox, pollers, health and
 * metrics, cache warm-up, and gherkin-ai's own runtime kernel. Left out like health endpoints.
 */
const TECHNICAL_WORDS = new Set(['outbox', 'relay', 'inbox', 'poll', 'poller', 'polling', 'heartbeat', 'health', 'healthcheck', 'metric', 'metrics', 'telemetry', 'tracing', 'dlq', 'deadletter', 'retry', 'retries', 'lease', 'leases', 'reaper', 'ping', 'warmup', 'cache', 'logrotate']);
export function isTechnicalEntry(e: SourceEvidence): boolean {
  const m = (e.metadata ?? {}) as { owner?: string; handler?: string; channel?: string };
  // Whole words, so `releaseExpiredReservations` (release) and `shippingJob` (shipping) are business jobs.
  const w = [m.owner, m.handler, m.channel].filter(Boolean).flatMap(s => words(pascal(s!)));
  return w.some(x => TECHNICAL_WORDS.has(x)) || /dead\s?letter/.test(w.join(' ')) || /(^|\/)runtime\//.test(e.location.file);
}

function entryCandidates(evidence: SourceEvidence[], unresolved: UnresolvedQuestion[]): BehaviorCandidate[] {
  const out: BehaviorCandidate[] = [];
  const entries = evidence.filter(e => (e.kind === 'message-handler' || e.kind === 'scheduled-job') && !isTechnicalEntry(e));
  for (const e of [...entries].sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.startLine - b.location.startLine)) {
    const meta = (e.metadata ?? {}) as { trigger: 'message' | 'schedule'; channel?: string; schedule?: string; handler?: string; owner?: string };
    const aggregate = entryAggregate(meta);
    const op = entryOperation(meta, aggregate);
    const related = evidence.filter(x => x.references.includes(e.id));
    const isEvent = meta.trigger === 'message' && Boolean(meta.channel) && looksLikeEvent(meta.channel!);
    const label = meta.trigger === 'message' ? (meta.channel ?? 'message') : (meta.schedule ?? `${meta.owner ?? meta.handler ?? 'job'} (background)`);
    const quote = (s: string) => s.replace(/"/g, "'");
    const whenText = meta.trigger === 'message'
      ? (isEvent ? `the "${channelName(meta.channel!)}" event is received` : `a message arrives on "${quote(meta.channel ?? 'its channel')}"`)
      : `the scheduled job runs${meta.schedule ? ` ("${quote(meta.schedule)}")` : ''}`;
    const when: ProposedStep = { keyword: 'When', text: whenText, evidence: [e.id] };
    const nounWords = words(op.name).slice(1).join(' ') || words(aggregate).join(' ');
    // "archives the delivered shipments", not "a delivered shipments".
    const lastNoun = nounWords.split(' ').pop() ?? '';
    const phrase = operationPhrase(op.name, op.verb, /[a-z]s$/.test(lastNoun) && !/ss$/.test(lastNoun) && !NOT_COLLECTIONS.test(lastNoun));

    const steps: ProposedStep[] = [when];
    const stateValues = new Map<string, string[]>();
    const stateEvidence = related.filter(x => x.kind === 'state-value');
    // A value the handler initialises and then changes is not an outcome: the last one written is.
    const written = stateEvidence.some(s => !(s.metadata as any)?.initial) ? stateEvidence.filter(s => !(s.metadata as any)?.initial) : stateEvidence;
    for (const s of written) {
      const v = String((s.metadata as any).value);
      stateValues.set(v, [...(stateValues.get(v) ?? []), s.id]);
    }
    for (const [value, ids] of stateValues) steps.push({ keyword: 'Then', text: `the ${words(aggregate).join(' ')} status is "${value}"`, evidence: ids });
    const eventNames = new Map<string, string[]>();
    for (const x of related.filter(r => r.kind === 'domain-event')) {
      const n = String((x.metadata as any).event);
      eventNames.set(n, [...(eventNames.get(n) ?? []), x.id]);
    }
    for (const [n, ids] of eventNames) steps.push({ keyword: 'Then', text: `the "${n}" event is published`, evidence: ids });

    const scenarios: ScenarioCandidate[] = [];
    const on = meta.trigger === 'message' ? ` on ${isEvent ? channelName(meta.channel!) : `"${quote(meta.channel ?? 'message')}"`}` : ' on schedule';
    if (steps.some(s => s.keyword === 'Then')) {
      scenarios.push({ name: `${capitalise(baseForm(phrase))}${on}`, category: 'happy-path', steps: normaliseKeywords(steps), confidence: minConfidence([e.confidence, maxConfidence(related.map(x => x.confidence))]) });
    } else {
      unresolved.push({ endpoint: `${meta.trigger === 'message' ? 'EVENT' : 'SCHEDULE'} ${label}`, question: `What does ${meta.handler ?? op.name} change when it runs (${label})? No state or event was found in the code.`, evidence: [e.id] });
    }
    for (const f of related.filter(x => x.kind === 'error-condition' && !(x.metadata as any)?.technical)) {
      const m = (f.metadata ?? {}) as any;
      const sc = failureScenario({ status: m.status, message: m.message, condition: m.condition, kind: f.kind, evidence: [f] }, { aggregate, noun: nounWords, phrase, when });
      if (sc && !scenarios.some(x => x.name === sc.name)) scenarios.push(sc);
    }
    out.push({
      id: `bc-${op.name}-${meta.trigger}`,
      aggregate,
      operation: { type: 'command', name: op.name, method: meta.trigger === 'message' ? 'EVENT' : 'SCHEDULE', path: label, phrase },
      endpointEvidence: [e.id],
      extractors: [...new Set([e, ...related].map(x => x.extractor))].sort(),
      scenarios,
      events: [...eventNames.keys()],
      confidence: scenarios[0]?.confidence ?? 'unknown'
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constraints and integrations (PLAN-3.3.0-reverse-plus RV-08)
// ---------------------------------------------------------------------------

/**
 * A unique constraint on the aggregate's entity backs its conflict scenarios (409): the database enforces what
 * the code returns, so the scenario is confirmed. A constraint with no conflict scenario, and every call to
 * another system, become open questions: the code does not say what the user sees when they fail.
 */
function attachConstraintsAndIntegrations(candidates: BehaviorCandidate[], evidence: SourceEvidence[], unresolved: UnresolvedQuestion[]): void {
  const constraints = evidence.filter(e => e.kind === 'persistence-constraint');
  const norm = (s: string) => singular(s.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const covered = new Set<string>();
  for (const c of candidates) {
    const mine = constraints.filter(k => norm(String((k.metadata as any)?.entity ?? '')) === norm(c.aggregate));
    if (!mine.length) continue;
    for (const sc of c.scenarios) {
      const then = sc.steps.find(s => s.keyword === 'Then' && /conflict|already exists|duplicate|already (registered|taken|in use)/i.test(s.text));
      if (!then) continue;
      then.evidence = [...new Set([...then.evidence, ...mine.map(k => k.id)])].sort();
      sc.confidence = 'confirmed';
      covered.add(norm(c.aggregate));
    }
  }
  for (const k of constraints) {
    const entity = String((k.metadata as any)?.entity ?? '');
    if (covered.has(norm(entity))) continue;
    const owner = candidates.find(c => norm(c.aggregate) === norm(entity) && c.operation.type === 'command' && c.operation.method === 'POST');
    if (!owner) continue;
    const fields = ((k.metadata as any)?.fields as string[] | undefined)?.join(', ');
    unresolved.push({ endpoint: `${owner.operation.method} ${owner.operation.path}`, question: `${entity} has a unique constraint${fields ? ` on ${fields}` : ''} (${k.location.file}:${k.location.startLine}). What does the user see when a duplicate is sent?`, evidence: [k.id] });
    covered.add(norm(entity));
  }
  for (const c of candidates) {
    const ids = new Set(c.endpointEvidence);
    for (const x of evidence.filter(e => e.kind === 'external-integration' && e.references.some(r => ids.has(r)))) {
      unresolved.push({ endpoint: `${c.operation.method} ${c.operation.path}`, question: `${c.operation.name} calls another system: ${x.description} (${x.location.file}:${x.location.startLine}). What does the user observe when that call fails or is slow?`, evidence: [x.id] });
    }
  }
}
