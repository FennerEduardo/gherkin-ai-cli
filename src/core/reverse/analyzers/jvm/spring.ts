/* ==========================================================================
   gherkin-ai-cli - Spring Boot and Quarkus (JAX-RS) adapter for `ghk reverse`
   (PLAN-3.3.0 R-07, beta). Java and Kotlin, through tree-sitter.

   - Routes: @RequestMapping on the class + @Get/Post/Put/Patch/DeleteMapping
     or @RequestMapping(method = …) on the method (Spring); @Path on the
     class and method + @GET/@POST/… (Quarkus, JAX-RS).
   - Security: @PreAuthorize("hasRole('X')"), @Secured, @RolesAllowed (403
     with the role), @Authenticated (401).
   - Input: the @RequestBody (Spring) or entity (JAX-RS) parameter's class,
     record or Kotlin data class, and its Bean Validation annotations.
   - Bodies: guarded failures (`if (…) throw …`, `?: throw …`,
     `.orElseThrow(() -> …)`, `return ResponseEntity.notFound()…`) with the
     status from HttpStatus / Response.Status, @ResponseStatus on the
     exception class or an @ExceptionHandler, or the exception's name;
     status values written; events constructed (`new OrderPlacedEvent(…)`)
     or sent to a topic; repository calls; and the services the controller
     calls, followed through the injected field's type, three levels deep.
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { joinPaths, makeEvidence, type EndpointMetadata, type EntryMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { failureKind, eventName } from '../typescript/ts-body';
import { childOfType, lineRange, ofType, parserFor, unquote, type TSNode } from '../treesitter/loader';
import { annotation, classesIn, type Annotation, type JvmClass, type JvmLanguage, type JvmMethod } from './jvm-model';

const ID = 'jvm/spring-quarkus';
const MAX_DEPTH = 3;

const HTTP_STATUS: Record<string, number> = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, GONE: 410, PRECONDITION_FAILED: 412, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422, UNPROCESSABLE_CONTENT: 422, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504
};
const SPRING_VERBS: Record<string, EndpointMetadata['method']> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE' };
const JAXRS_VERBS: Record<string, EndpointMetadata['method']> = { GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE' };
const JAXRS_EXCEPTIONS: Record<string, number> = { NotFoundException: 404, BadRequestException: 400, ForbiddenException: 403, NotAuthorizedException: 401, NotAllowedException: 405, NotAcceptableException: 406, InternalServerErrorException: 500, ServiceUnavailableException: 503 };
const VALIDATORS: Record<string, string> = {
  NotNull: 'required', NotBlank: 'required', NotEmpty: 'required', Email: 'email', Min: 'min', Max: 'max', Positive: 'positive', PositiveOrZero: 'min',
  DecimalMin: 'min', DecimalMax: 'max', Size: 'length', Pattern: 'pattern', Past: 'date', Future: 'date', PastOrPresent: 'date', FutureOrPresent: 'date', Digits: 'pattern'
};
/** Event classes that carry the event name as data, or that are not domain events at all. */
const GENERIC_EVENT = /^(Domain|Integration|Outbox|Base|Abstract|Incoming|Outgoing|Application|Spring|Context\w*|Servlet\w*|Cloud|Message|Generic)?Event$|DomainEvent$|IntegrationEvent$/;
const REPO_METHOD = /^(save|saveAll|saveAndFlush|insert|update|delete|deleteById|deleteAll|remove|persist|persistAndFlush|merge|find\w*|get\w*|count\w*|exists\w*|list\w*|stream\w*)$/;
/** HTTP client types injected into a service: a call through them reaches another system (RV-08). */
const EXTERNAL_CLIENT = /^(RestTemplate|WebClient|RestClient|HttpClient|OkHttpClient|CloseableHttpClient|WebTarget|StripeClient|SesClient|SnsClient|S3Client)$/;
/** Message listeners and scheduled methods (PLAN-3.3.0-reverse-plus RV-06). */
const LISTENERS = new Set(['KafkaListener', 'RabbitListener', 'JmsListener', 'SqsListener', 'StreamListener', 'Incoming', 'ConsumeEvent', 'EventListener', 'TransactionalEventListener', 'ObservesAsync']);

/** The channel a listener annotation names, or the event class its first parameter takes. */
function listenerChannel(a: Annotation, m: JvmMethod): string | undefined {
  const named = a.pairs.topics ?? a.pairs.queues ?? a.pairs.destination ?? a.pairs.value ?? a.pairs.address;
  const literal = (named && unquote(named.replace(/^[{[]|[}\]]$/g, '').split(',')[0].trim())) ?? a.strings[0];
  if (literal) return literal;
  const type = m.params[0]?.type?.replace(/<.*$/, '');
  return type && /^[A-Z]/.test(type) ? eventName(type) : undefined;
}

/** First HTTP status a piece of code names: HttpStatus.X, Response.Status.X, .status(404), ResponseEntity.notFound(), Response.created(…). */
export function statusFromText(text: string): number | undefined {
  const named = text.match(/\b(?:HttpStatus|Status|HttpStatusCode)\.([A-Z_]+)/);
  if (named && HTTP_STATUS[named[1]]) return HTTP_STATUS[named[1]];
  const numeric = text.match(/\.(?:status|valueOf)\(\s*(\d{3})\s*\)|ResponseStatusException\(\s*(\d{3})/);
  if (numeric) return Number(numeric[1] ?? numeric[2]);
  const builder = text.match(/\b(?:ResponseEntity|Response)\s*\.\s*(notFound|badRequest|unprocessableEntity|noContent|accepted|created|ok|internalServerError)\s*\(/);
  if (builder) return ({ notFound: 404, badRequest: 400, unprocessableEntity: 422, noContent: 204, accepted: 202, created: 201, ok: 200, internalServerError: 500 } as Record<string, number>)[builder[1]];
  return undefined;
}

/** `throw new XException(HttpStatus.NOT_FOUND, "msg")` / `throw X("msg")` → exception, message, status named in the arguments. */
export function throwFromText(text: string): { exception: string; message?: string; status?: number } | undefined {
  const m = text.match(/\bthrow\s+(?:new\s+)?([A-Z][\w.]*)\s*\(([\s\S]*)\)/) ?? text.match(/->\s*(?:new\s+)?([A-Z][\w.]*(?:Exception|Error))\s*\(([\s\S]*)\)/) ?? text.match(/\{\s*([A-Z]\w*(?:Exception|Error))\s*\(([\s\S]*)\)\s*\}/);
  if (!m) return undefined;
  const lit = m[2].match(/"((?:[^"\\]|\\.)*)"/);
  return { exception: m[1].split('.').pop()!, message: lit ? unquote(`"${lit[1]}"`) : undefined, status: statusFromText(m[2]) };
}

/** Exception name → status, from the project (@ResponseStatus, @ExceptionHandler) or from the name. */
export function exceptionStatusByName(name: string): number | undefined {
  if (JAXRS_EXCEPTIONS[name]) return JAXRS_EXCEPTIONS[name];
  if (/NotFound|NoSuch|Missing(?!Param)/.test(name)) return 404;
  // A state violation (InvalidOperationException in .NET, IllegalStateException in Java) is a conflict, not bad input.
  if (/Conflict|AlreadyExists|Duplicate|Already[A-Z]|Concurrent|OptimisticLock|StateConflict|InvalidOperation|IllegalState|InvalidState/.test(name)) return 409;
  if (/Forbidden|AccessDenied|NotAllowed|Permission/.test(name)) return 403;
  if (/Unauthori[sz]ed|Unauthenticated|Authentication/.test(name)) return 401;
  if (/Invalid|BadRequest|Validation|Constraint|IllegalArgument|MethodArgumentNotValid/.test(name)) return 400;
  if (/Unprocessable|BusinessRule|Domain(?:Validation)?(?:Exception|Error)/.test(name)) return 422;
  return undefined;
}

function rolesOf(a: Annotation): string[] {
  const text = a.strings.join(' ') || a.raw;
  const roles = [...text.matchAll(/has(?:Any)?(?:Role|Authority)\(([^)]*)\)/g)].flatMap(m => m[1].split(',').map(r => r.replace(/['"\s]/g, '')));
  if (roles.length) return roles.map(r => r.replace(/^ROLE_/, ''));
  if (a.name === 'Secured' || a.name === 'RolesAllowed') return a.strings.map(r => r.replace(/^ROLE_/, ''));
  return [];
}

const pathArg = (a: Annotation | undefined) => (a ? unquote(a.pairs.value ?? a.pairs.path ?? '') ?? a.strings[0] : undefined);

interface Index {
  classes: Map<string, JvmClass[]>;
  /** Exception class → status from @ResponseStatus on the class or an @ExceptionHandler. */
  exceptionStatus: Map<string, number>;
}

function buildIndex(classes: JvmClass[]): Index {
  const byName = new Map<string, JvmClass[]>();
  for (const c of classes) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const exceptionStatus = new Map<string, number>();
  for (const c of classes) {
    const rs = annotation(c.annotations, 'ResponseStatus');
    const s = rs ? statusFromText(rs.raw) : undefined;
    if (s) exceptionStatus.set(c.name, s);
    // JAX-RS: class XMapper implements ExceptionMapper<XException> { Response toResponse(…) { return Response.status(…) } }
    const mapped = c.node.text.split('{')[0].match(/ExceptionMapper\s*<\s*(\w+)\s*>/)?.[1];
    if (mapped) {
      const status = statusFromText(c.methods.find(m => m.name === 'toResponse')?.body?.text ?? '');
      if (status) exceptionStatus.set(mapped, status);
    }
    for (const m of c.methods) {
      const handler = annotation(m.annotations, 'ExceptionHandler');
      if (!handler) continue;
      const status = statusFromText(annotation(m.annotations, 'ResponseStatus')?.raw ?? '') ?? statusFromText(m.body?.text ?? '');
      const handled = [...handler.raw.matchAll(/([A-Z]\w*)(?:::class|\.class)/g)].map(x => x[1]);
      if (!handled.length && m.params[0]) handled.push(m.params[0].type);
      for (const h of handled) if (status && !exceptionStatus.has(h)) exceptionStatus.set(h, status);
    }
  }
  // Subclasses inherit their parent's mapping.
  for (const c of classes) {
    let parent = c.superclass;
    for (let i = 0; parent && i < 5 && !exceptionStatus.has(c.name); i++) {
      const s = exceptionStatus.get(parent);
      if (s) exceptionStatus.set(c.name, s);
      parent = byName.get(parent)?.[0]?.superclass;
    }
  }
  return { classes: byName, exceptionStatus };
}

interface BodyCtx {
  ctx: AnalysisContext;
  index: Index;
  endpointId: string;
  owner: JvmClass;
  depth: number;
  visited: Set<string>;
}

const loc = (file: string, node: TSNode) => ({ file, ...lineRange(node) });

function failureEvidence(b: BodyCtx, node: TSNode, condition: string, branch: string): SourceEvidence | undefined {
  const thrown = throwFromText(branch);
  const status = thrown?.status ?? (thrown ? b.index.exceptionStatus.get(thrown.exception) ?? exceptionStatusByName(thrown.exception) : statusFromText(branch));
  if (!thrown && (status === undefined || status < 400)) return undefined;
  if (status !== undefined && status < 400) return undefined;
  const message = thrown?.message ?? branch.match(/"((?:[^"\\]|\\.){4,})"/)?.[1];
  const { kind, technical } = failureKind(status ?? (thrown && /Auth|Forbidden|Permission/.test(thrown.exception) ? 403 : undefined));
  return makeEvidence({
    kind, extractor: ID, confidence: status !== undefined ? 'strong' : 'inferred', references: [b.endpointId], location: loc(b.owner.file, node),
    symbol: thrown?.exception, description: `${message ?? thrown?.exception ?? `status ${status}`} when ${condition}`,
    metadata: { condition, status, message, exception: thrown?.exception, technical }, key: `${condition}|${status}|${message ?? ''}`
  });
}

function analyzeBody(method: JvmMethod, b: BodyCtx): SourceEvidence[] {
  const key = `${b.owner.file}:${method.node.startIndex}`;
  if (!method.body || b.visited.has(key) || b.depth > MAX_DEPTH) return [];
  b.visited.add(key);
  const body = method.body;
  const out: SourceEvidence[] = [];
  const failureRanges: [number, number][] = [];
  const java = b.owner.lang === 'java';

  // Guarded failures.
  for (const ifNode of ofType(body, java ? 'if_statement' : 'if_expression')) {
    const cond = java ? ifNode.childForFieldName('condition') : ifNode.namedChildren[0];
    const then = java ? ifNode.childForFieldName('consequence') : childOfType(ifNode, 'control_structure_body');
    if (!cond || !then) continue;
    const e = failureEvidence(b, ifNode, cond.text.replace(/^\(|\)$/g, '').replace(/\s+/g, ' '), then.text);
    if (e) { out.push(e); failureRanges.push([then.startIndex, then.endIndex]); }
  }
  // Kotlin `x ?: throw …` and Java/Kotlin `.orElseThrow(() -> …)`: "when x is absent".
  for (const elvis of ofType(body, 'elvis_expression')) {
    const last = elvis.namedChildren[elvis.namedChildren.length - 1];
    if (last && /^throw\b/.test(last.text)) {
      const e = failureEvidence(b, elvis, `${elvis.namedChildren[0]?.text ?? 'value'} == null`, last.text);
      if (e) { out.push(e); failureRanges.push([last.startIndex, last.endIndex]); }
    }
  }
  for (const call of ofType(body, java ? 'method_invocation' : 'call_expression')) {
    const name = java ? call.childForFieldName('name')?.text : call.text.match(/\.(\w+)\s*(?:\{|\()/g)?.pop()?.replace(/[.({\s]/g, '');
    if (name !== 'orElseThrow') continue;
    const receiver = java ? call.childForFieldName('object')?.text : call.text.replace(/\.orElseThrow[\s\S]*$/, '');
    const e = failureEvidence(b, call, `${receiver ?? 'value'} is empty`, call.text.slice(call.text.indexOf('orElseThrow')));
    if (e) { out.push(e); failureRanges.push([call.startIndex, call.endIndex]); }
  }
  const inFailure = (n: TSNode) => failureRanges.some(([s, e]) => n.startIndex >= s && n.endIndex <= e);

  // Success status from the returns outside the failure branches (Kotlin expression bodies included).
  const returns = java ? ofType(body, 'return_statement') : [...ofType(body, 'jump_expression').filter(j => /^return\b/.test(j.text)), ...(/^=/.test(body.text) ? [body] : [])];
  for (const r of returns) {
    if (inFailure(r)) continue;
    const s = statusFromText(r.text);
    if (s !== undefined && s < 400) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, r), description: `responds ${s}`, metadata: { status: s } }));
  }

  // Status values written: x.status = Status.X / x.setStatus(Status.X) / status = "X" / statuses.put(id, "X") / "status" to "X".
  const text = body.text;
  const lineAt = (offset: number) => body.startPosition.row + 1 + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
  const state = (value: string, offset: number, how: string) => {
    if (!/^[A-Za-z][\w-]{1,40}$/.test(value)) return;
    const line = lineAt(offset);
    out.push(makeEvidence({ kind: 'state-value', extractor: ID, confidence: 'strong', references: [b.endpointId], location: { file: b.owner.file, startLine: line, endLine: line }, description: `status ${how} ${value}`, metadata: { field: 'status', value } }));
  };
  for (const m of text.matchAll(/\.(?:status|state)\s*=\s*(?:[\w.]*(?:Status|State)\.)?"?([A-Za-z][\w-]*)"?/gi)) state(m[1], m.index!, 'set to');
  for (const m of text.matchAll(/\.set(?:Status|State)\(\s*(?:[\w.]*\.)?"?([A-Za-z][\w-]*)"?\s*\)/g)) state(m[1], m.index!, 'set to');
  for (const m of text.matchAll(/\b\w*(?:status|state)\w*\.put\([^,()]+,\s*(?:[\w.]*\.)?"?([A-Za-z][\w-]*)"?\s*\)/gi)) state(m[1], m.index!, 'set to');
  for (const m of text.matchAll(/"(?:status|state)"\s*(?:,|to)\s*"([A-Za-z][\w-]*)"/g)) state(m[1], m.index!, 'returned as');
  for (const m of text.matchAll(/\b(?:status|state)\s*=\s*(?:[\w.]*(?:Status|State)\.)([A-Za-z][\w-]*)/g)) state(m[1], m.index!, 'created with');

  // Events: a class per event (new OrderPlacedEvent(…)), a generic class named by its first argument
  // (new DomainEvent("OrderPlaced", …)), an event-type enum (record(OrderEventType.OrderPlaced, …)), or a topic.
  const event = (name: string, offset: number, symbol: string) => {
    const line = lineAt(offset);
    out.push(makeEvidence({ kind: 'domain-event', extractor: ID, confidence: 'strong', references: [b.endpointId], location: { file: b.owner.file, startLine: line, endLine: line }, symbol, description: `publishes ${name}`, metadata: { event: name } }));
  };
  for (const m of text.matchAll(/\b(?:new\s+)?([A-Z]\w*Event)\s*(?:\.of)?\(\s*(?:"([A-Z][A-Za-z0-9]+)")?/g)) {
    if (m[2]) { event(m[2], m.index!, m[1]); continue; }
    if (GENERIC_EVENT.test(m[1])) continue;
    event(eventName(m[1]), m.index!, m[1]);
  }
  for (const m of text.matchAll(/\b\w*EventTypes?\.([A-Z][A-Za-z0-9]+)/g)) event(m[1], m.index!, m[0]);
  for (const m of text.matchAll(/\b\w*(?:kafka|rabbit|template|emitter|producer|bus)\w*\.(?:send|convertAndSend|publish)\(\s*"([\w.-]+)"/gi)) {
    const line = lineAt(m.index!);
    out.push(makeEvidence({ kind: 'domain-event', extractor: ID, confidence: 'strong', references: [b.endpointId], location: { file: b.owner.file, startLine: line, endLine: line }, symbol: m[1], description: `publishes ${eventName(m[1])}`, metadata: { event: eventName(m[1]), channel: m[1] } }));
  }

  // Calls on injected fields: repositories, and services followed into their declaration.
  for (const call of ofType(body, java ? 'method_invocation' : 'call_expression')) {
    let receiver: string | undefined;
    let name: string | undefined;
    if (java) {
      receiver = call.childForFieldName('object')?.text.replace(/^this\./, '');
      name = call.childForFieldName('name')?.text;
    } else {
      const nav = childOfType(call, 'navigation_expression');
      receiver = nav?.namedChildren[0]?.type === 'simple_identifier' ? nav.namedChildren[0].text : nav?.namedChildren[0]?.text.replace(/^this\./, '');
      name = childOfType(childOfType(nav, 'navigation_suffix'), 'simple_identifier')?.text;
    }
    if (!receiver || !name || !/^\w+$/.test(receiver)) continue;
    const type = b.owner.fields.get(receiver);
    // Calls to other systems (PLAN-3.3.0-reverse-plus RV-08): HTTP clients, and Feign / MicroProfile REST clients.
    const restClient = type ? b.index.classes.get(type)?.find(c => c.annotations.some(a => a.name === 'FeignClient' || a.name === 'RegisterRestClient')) : undefined;
    if (type && (EXTERNAL_CLIENT.test(type) || restClient)) {
      const url = call.text.match(/"((?:https?:)?\/\/[^"?#]+|\/[\w/{}.-]*)"/)?.[1];
      out.push(makeEvidence({ kind: 'external-integration', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${type}.${name}`, description: `${restClient ? `REST client ${type}` : type}.${name}${url ? ` ${url}` : ''}`, metadata: { client: type, method: name, url } }));
      continue;
    }
    if (!type) {
      // Static factory on a project class (Course.create(…)), or a method of a loaded entity (period.open()):
      // followed when exactly one project class declares a method of that name.
      const target = /^[A-Z]/.test(receiver) ? b.index.classes.get(receiver)?.find(c => c.methods.some(m => m.name === name && m.body)) : uniqueDeclarer(b.index, name, b.owner);
      const callee = target?.methods.find(m => m.name === name && m.body);
      if (target && callee) {
        out.push(makeEvidence({ kind: 'service-call', extractor: ID, confidence: /^[A-Z]/.test(receiver) ? 'strong' : 'inferred', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${target.name}.${name}`, description: `calls ${target.name}.${name}`, metadata: { target: target.name, method: name, declaredIn: target.file } }));
        out.push(...analyzeBody(callee, { ...b, owner: target, depth: b.depth + 1 }));
      }
      continue;
    }
    if (/(Repository|Repo|Dao|Store)$/.test(type) || /(repository|repo|dao)$/i.test(receiver)) {
      if (REPO_METHOD.test(name)) out.push(makeEvidence({ kind: 'repository-query', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${type}.${name}`, description: `${/^(find|get|count|exists|list|stream)/.test(name) ? 'reads' : 'writes'} ${type.replace(/(Repository|Repo|Dao|Store)$/, '')}`, metadata: { target: type, method: name, write: !/^(find|get|count|exists|list|stream)/.test(name) } }));
      continue;
    }
    const target = resolveImplementation(b.index, type);
    const callee = target?.methods.find(m => m.name === name && m.body);
    if (!target || !callee) continue;
    out.push(makeEvidence({ kind: 'service-call', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${target.name}.${name}`, description: `calls ${target.name}.${name}`, metadata: { target: target.name, method: name, declaredIn: target.file } }));
    out.push(...analyzeBody(callee, { ...b, owner: target, depth: b.depth + 1 }));
  }
  return out;
}

/** Common names that many classes declare (accessors, Object methods): never followed by name alone. */
const AMBIGUOUS_METHODS = /^(get\w*|set\w*|is\w*|has\w*|to\w*|equals|hashCode|of|from|valueOf|build|builder|id|name|size|isEmpty|map|stream|apply|run|execute|handle|validate|copy|close)$/;

/** The one project class (not a controller, not the caller) that declares a method with this name. */
function uniqueDeclarer(index: Index, method: string, caller: JvmClass): JvmClass | undefined {
  if (AMBIGUOUS_METHODS.test(method)) return undefined;
  const found: JvmClass[] = [];
  for (const list of index.classes.values()) {
    for (const c of list) {
      if (c === caller || c.kind === 'interface' || c.annotations.some(a => /Controller$|^Path$/.test(a.name))) continue;
      if (c.methods.some(m => m.name === method && m.body)) found.push(c);
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** The class behind an injected type: the class itself, or the one implementing the interface. */
function resolveImplementation(index: Index, type: string): JvmClass | undefined {
  const own = index.classes.get(type)?.find(c => c.kind === 'class' || c.kind === 'object');
  if (own) return own;
  const impl = index.classes.get(`${type}Impl`)?.[0];
  if (impl) return impl;
  for (const list of index.classes.values()) {
    for (const c of list) if (c.kind === 'class' && new RegExp(`\\b(?:implements|:)\\s*[^{]*\\b${type}\\b`).test(c.node.text.split('{')[0])) return c;
  }
  return undefined;
}

function endpointsOf(cls: JvmClass): { method: JvmMethod; verb: EndpointMetadata['method']; path: string; jaxrs: boolean }[] {
  const out: { method: JvmMethod; verb: EndpointMetadata['method']; path: string; jaxrs: boolean }[] = [];
  const springPrefix = pathArg(annotation(cls.annotations, 'RequestMapping'));
  const jaxrsPrefix = pathArg(annotation(cls.annotations, 'Path'));
  for (const m of cls.methods) {
    const spring = m.annotations.find(a => SPRING_VERBS[a.name]);
    const request = annotation(m.annotations, 'RequestMapping');
    const jaxrs = m.annotations.find(a => JAXRS_VERBS[a.name]);
    if (spring) out.push({ method: m, verb: SPRING_VERBS[spring.name], path: joinPaths(springPrefix, pathArg(spring)), jaxrs: false });
    else if (request) {
      const verb = (request.pairs.method ?? request.raw).match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/)?.[1] as EndpointMetadata['method'] | undefined;
      out.push({ method: m, verb: verb ?? 'GET', path: joinPaths(springPrefix, pathArg(request)), jaxrs: false });
    } else if (jaxrs) out.push({ method: m, verb: JAXRS_VERBS[jaxrs.name], path: joinPaths(jaxrsPrefix, pathArg(annotation(m.annotations, 'Path'))), jaxrs: true });
  }
  return out;
}

function securityEvidence(cls: JvmClass, m: JvmMethod, endpointId: string): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  for (const a of [...cls.annotations, ...m.annotations]) {
    if (['PreAuthorize', 'Secured', 'RolesAllowed'].includes(a.name)) {
      const roles = rolesOf(a);
      const authenticatedOnly = !roles.length && /isAuthenticated|authenticated/.test(a.raw);
      out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpointId], location: loc(cls.file, a.node), description: roles.length ? `requires role ${roles.join(', ')}` : `requires ${a.raw || a.name}`, metadata: { roles: roles.length ? roles : undefined, status: authenticatedOnly ? 401 : 403 } }));
    }
    if (a.name === 'Authenticated') out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpointId], location: loc(cls.file, a.node), description: 'requires an authenticated user', metadata: { status: 401 } }));
  }
  return out;
}

function inputEvidence(m: JvmMethod, jaxrs: boolean, index: Index, endpointId: string): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  const NON_BODY = /^(PathVariable|RequestParam|RequestHeader|CookieValue|PathParam|QueryParam|HeaderParam|CookieParam|Context|BeanParam|FormParam|AuthenticationPrincipal|RestPath|RestQuery|RestHeader)$/;
  const bodyParam = m.params.find(p => p.annotations.some(a => a.name === 'RequestBody')) ?? (jaxrs ? m.params.find(p => !p.annotations.some(a => NON_BODY.test(a.name)) && /^[A-Z]/.test(p.type) && !/^(String|Long|Integer|UUID|Boolean)$/.test(p.type)) : undefined);
  if (!bodyParam) return out;
  const dto = index.classes.get(bodyParam.type)?.[0];
  if (!dto) return out;
  for (const prop of dto.properties) {
    for (const a of prop.annotations) {
      const rule = VALIDATORS[a.name];
      if (!rule) continue;
      out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpointId], location: loc(dto.file, a.node), symbol: `${dto.name}.${prop.name}`, description: `${prop.name} ${rule}`, metadata: { field: prop.name, rule, param: a.raw || undefined, status: 400, dto: dto.name } }));
    }
  }
  out.push(makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: dto.file, ...lineRange(dto.node) }, symbol: dto.name, description: `body ${dto.name} (${dto.properties.map(p => p.name).join(', ')})`, metadata: { dto: dto.name, fields: dto.properties.map(p => ({ name: p.name, type: p.type, rules: p.annotations.map(a => VALIDATORS[a.name]).filter(Boolean) })) } }));
  return out;
}

const spring: SourceAnalyzer = {
  id: ID,
  language: 'java+kotlin',
  frameworks: ['spring-boot', 'quarkus'],
  maturity: 'beta',
  detect(ctx) {
    return ctx.files.some(f => (f.ext === '.java' || f.ext === '.kt') && !isTestFile(f.rel) && (() => {
      try { return /@(RestController|Controller|Path|KafkaListener|RabbitListener|JmsListener|SqsListener|Incoming|ConsumeEvent|Scheduled|EventListener|TransactionalEventListener)\b|import (?:jakarta|javax)\.ws\.rs/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    })());
  },
  async analyze(ctx) {
    const sources = ctx.files.filter(f => (f.ext === '.java' || f.ext === '.kt') && !isTestFile(f.rel) && !/(^|\/)(build|target|generated)\//.test(f.rel));
    const parsers: Partial<Record<JvmLanguage, Awaited<ReturnType<typeof parserFor>>>> = {};
    const classes: JvmClass[] = [];
    for (const f of sources) {
      const lang: JvmLanguage = f.ext === '.kt' ? 'kotlin' : 'java';
      let text: string;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      parsers[lang] ??= await parserFor(lang);
      const tree = parsers[lang]!.parse(text);
      if (tree) classes.push(...classesIn(tree.rootNode, f.rel, lang));
    }
    const index = buildIndex(classes);
    const out: SourceEvidence[] = [];
    for (const cls of classes) {
      // Message listeners and scheduled jobs, in any class (RV-06). Their bodies are analysed as an endpoint's.
      for (const m of cls.methods) {
        const listener = m.annotations.find(a => LISTENERS.has(a.name));
        const observes = m.params.find(p => p.annotations.some(a => a.name === 'Observes' || a.name === 'ObservesAsync'));
        const scheduled = annotation(m.annotations, 'Scheduled');
        const kind = listener || observes ? 'message-handler' as const : scheduled ? 'scheduled-job' as const : undefined;
        if (!kind) continue;
        const channel = listener ? listenerChannel(listener, m) : observes ? eventName(observes.type.replace(/<.*$/, '')) : undefined;
        const schedule = scheduled ? (unquote(scheduled.pairs.cron ?? scheduled.pairs.every ?? '') ?? Object.entries(scheduled.pairs).map(([k, v]) => `${k} = ${v}`).join(', ')) || scheduled.raw : undefined;
        const meta: EntryMetadata = kind === 'message-handler' ? { trigger: 'message', channel, handler: m.name, owner: cls.name } : { trigger: 'schedule', schedule, handler: m.name, owner: cls.name };
        const entry = makeEvidence({
          kind, extractor: ID, confidence: 'strong', location: loc(cls.file, m.node), symbol: `${cls.name}.${m.name}`,
          description: kind === 'message-handler' ? `handles ${channel ?? 'messages'}` : `runs on schedule ${schedule ?? ''}`.trim(),
          metadata: meta as unknown as Record<string, unknown>, key: `${kind}|${channel ?? schedule ?? ''}|${m.name}`
        });
        out.push(entry);
        out.push(...analyzeBody(m, { ctx, index, endpointId: entry.id, owner: cls, depth: 0, visited: new Set() }).filter(e => e.kind !== 'success-response'));
      }
      const isController = cls.annotations.some(a => a.name === 'RestController' || a.name === 'Controller') || Boolean(annotation(cls.annotations, 'Path'));
      if (!isController) continue;
      for (const ep of endpointsOf(cls)) {
        const endpoint = makeEvidence({
          kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: loc(cls.file, ep.method.node),
          symbol: `${cls.name}.${ep.method.name}`, description: `${ep.verb} ${ep.path}`, key: `${ep.verb} ${ep.path}`,
          metadata: { method: ep.verb, path: ep.path, handler: ep.method.name, owner: cls.name } satisfies EndpointMetadata
        });
        out.push(endpoint);
        const declared = statusFromText(annotation(ep.method.annotations, 'ResponseStatus')?.raw ?? '');
        if (declared) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'strong', references: [endpoint.id], location: endpoint.location, description: `responds ${declared}`, metadata: { status: declared } }));
        out.push(...securityEvidence(cls, ep.method, endpoint.id), ...inputEvidence(ep.method, ep.jaxrs, index, endpoint.id));
        const body = analyzeBody(ep.method, { ctx, index, endpointId: endpoint.id, owner: cls, depth: 0, visited: new Set() });
        out.push(...body);
        if (!declared && !body.some(e => e.kind === 'success-response')) {
          out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location: endpoint.location, description: 'responds 200', metadata: { status: 200 } }));
        }
      }
    }
    return out;
  }
};

export default spring;
