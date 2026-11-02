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
}

export type ScenarioKind = 'happy-path' | 'validation' | 'authorization' | 'error-handling';

export interface ScenarioCandidate {
  name: string;
  category: ScenarioKind;
  steps: ProposedStep[];
  confidence: EvidenceConfidence;
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
  'get', 'list', 'retrieve', 'find', 'fetch', 'register', 'enroll', 'initiate', 'execute', 'link', 'unlink', 'set', 'add', 'remove', 'mark', 'notify', 'capture', 'evaluate', 'provide', 'change', 'save', 'edit', 'replace', 'patch', 'put', 'post', 'upsert', 'generate', 'sync', 'count', 'check', 'validate', 'login', 'logout', 'refresh']);
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

const article = (noun: string) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');

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
    const noun = rest.length ? pascal(rest.join(' ')) : (verb === 'list' ? plural(aggregate) : aggregate);
    return { name: pascal(verb) + noun, type: (verb === 'get' || verb === 'list' || verb === 'search' || verb === 'find' || verb === 'count') ? 'query' as const : type, verb };
  };
  const named = (operationId && fromName(operationId)) || (meta.handler && fromName(meta.handler));
  if (named) return named;
  const segs = meta.path.split('/').filter(Boolean);
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
  const quoted = f.message && f.message.length <= 80 ? `"${f.message.replace(/"/g, "'")}"` : undefined;
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
    const what = f.field ? (f.rule === 'required' ? `${field} ${be} missing` : `${field} ${be} not ${ruleWords(f.rule, f.message)}`) : (f.message ? lowerFirst(f.message) : 'the input is invalid');
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
      : `${capitalise(gerund(ctx.phrase))} fails when ${f.message ? f.message.toLowerCase() : `the result is ${as}`}`;
  }
  steps.push({ ...ctx.when, keyword: 'When' });
  steps.push({ keyword: 'Then', text: then, evidence: ids });
  return { name: name.replace(/\s+/g, ' ').trim(), category, steps: normaliseKeywords(steps), confidence: conf };
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

  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // The code adapter names things; the contract confirms. Prefer code metadata, keep the operationId.
    const code = group.find(e => e.extractor !== 'openapi') ?? group[0];
    const meta = { ...(code.metadata as unknown as EndpointMetadata) };
    const operationId = group.map(e => (e.metadata as any)?.operationId).find(Boolean) as string | undefined;
    const ids = new Set(group.map(e => e.id));
    const related = evidence.filter(e => e.references.some(r => ids.has(r)));
    // A test calls a concrete URL (`/orders/o-1/cancel`) or the template itself.
    const testHits = tests.filter(t => (t.metadata as any)?.method === meta.method && pathMatchesTemplate(meta.path, String((t.metadata as any)?.path ?? '')));
    const aggregate = aggregateFromEndpoint(meta);
    const op = operationName(meta, aggregate, operationId);
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
      const k = e.kind === 'validation-rule' && m.field ? `field:${m.field}` : e.kind === 'authorization-rule' ? `auth:${m.status === 403 || m.roles ? 403 : 401}` : `status:${m.status ?? '?'}|${(m.message ?? m.condition ?? '').toLowerCase()}`;
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
      failures.set(k, { status: m.status, message: m.message, condition: m.condition, field: m.field, rule: m.rule, roles: m.roles, kind: e.kind, evidence: [e] });
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
    for (const f of [...failures.values()].sort((a, b) => (a.status ?? 0) - (b.status ?? 0) || (a.field ?? '').localeCompare(b.field ?? ''))) {
      const sc = failureScenario(f, { aggregate, noun, phrase, when, givenItem, auth: f.kind === 'authorization-rule' ? undefined : authStep });
      if (sc) scenarios.push(sc);
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
