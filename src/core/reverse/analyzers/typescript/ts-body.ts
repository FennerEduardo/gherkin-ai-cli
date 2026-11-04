/* ==========================================================================
   gherkin-ai-cli - Behaviour inside a TypeScript/JavaScript handler

   Shared by the Express and NestJS adapters. Walks a handler body (and the
   service methods it calls, through the type checker, a few levels deep)
   and records what is observable from outside:
   - guarded failures: `if (cond) return res.status(4xx)…` / `throw new XException(…)`;
   - status values written (`order.status = 'CANCELLED'`, `{ status: 'PENDING' }`);
   - events published (`emit('order.placed')`, `new OrderPlacedEvent()`);
   - persistence (`this.orders.save`, `this.prisma.order.create`);
   - the success response (`res.status(201)`).
   Conditions that are technical (5xx, infrastructure) are kept but marked,
   so the candidate builder never turns them into business scenarios.
   ========================================================================== */

import path from 'path';
import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, IfStatement } from 'ts-morph';
import { makeEvidence, type EvidenceKind, type SourceEvidence } from '../../evidence';

export interface BodyContext {
  root: string;
  extractor: string;
  /** The endpoint the behaviour belongs to; every evidence references it. */
  endpointId: string;
  depth?: number;
  visited?: Set<string>;
}

const MAX_DEPTH = 3;

/** NestJS / common HTTP exception names → status. */
export const EXCEPTION_STATUS: Record<string, number> = {
  BadRequestException: 400, ValidationException: 400, ValidationError: 400, UnauthorizedException: 401, AuthenticationError: 401,
  ForbiddenException: 403, AccessDeniedException: 403, NotFoundException: 404, EntityNotFoundException: 404, NotFoundError: 404,
  ConflictException: 409, GoneException: 410, PreconditionFailedException: 412, PayloadTooLargeException: 413,
  UnprocessableEntityException: 422, TooManyRequestsException: 429,
  InternalServerErrorException: 500, NotImplementedException: 501, BadGatewayException: 502, ServiceUnavailableException: 503, GatewayTimeoutException: 504
};

export function relPath(root: string, node: Node): string {
  return path.relative(root, node.getSourceFile().getFilePath()).split(path.sep).join('/');
}

const loc = (root: string, node: Node) => ({ file: relPath(root, node), startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() });

/** `"order.placed"`, `order_placed`, `ORDER_PLACED`, `OrderPlacedEvent` → `OrderPlaced`. */
export function eventName(raw: string): string {
  const words = raw.replace(/Event$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
}

/** What kind of rule a failure is, from its status (or exception). */
export function failureKind(status: number | undefined): { kind: EvidenceKind; technical: boolean } {
  if (status === 401 || status === 403) return { kind: 'authorization-rule', technical: false };
  if (status === 400 || status === 422) return { kind: 'validation-rule', technical: false };
  return { kind: 'error-condition', technical: status !== undefined && status >= 500 };
}

const stringValue = (n: Node | undefined): string | undefined =>
  n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) ? n.getLiteralValue() : undefined;

/** The human message of a failure: `.json({ detail|message|error: '…' })`, `.send('…')`, or an exception argument. */
function messageIn(node: Node): string | undefined {
  for (const call of [node, ...node.getDescendants()].filter(Node.isCallExpression)) {
    const name = calleeName(call);
    const arg = call.getArguments()[0];
    if ((name === 'json' || name === 'send') && arg) {
      const direct = stringValue(arg);
      if (direct) return direct;
      if (Node.isObjectLiteralExpression(arg)) {
        for (const key of ['detail', 'message', 'error', 'title', 'reason']) {
          const prop = arg.getProperty(key);
          if (prop && Node.isPropertyAssignment(prop)) {
            const v = stringValue(prop.getInitializer());
            if (v) return v;
          }
        }
      }
    }
  }
  return undefined;
}

export function calleeName(call: CallExpression): string {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  if (Node.isIdentifier(expr)) return expr.getText();
  return '';
}

/** `res.status(404)`, `reply.code(404)`, `res.sendStatus(404)` anywhere in the node. */
function statusIn(node: Node): { status: number; at: Node } | undefined {
  for (const call of [node, ...node.getDescendants()].filter(Node.isCallExpression)) {
    const name = calleeName(call);
    if (name === 'status' || name === 'sendStatus' || name === 'code') {
      const arg = call.getArguments()[0];
      if (arg && Node.isNumericLiteral(arg)) {
        const target = (call.getExpression() as Node).getText();
        if (/\b(res|response|reply|ctx|c)\b/.test(target) || name === 'sendStatus') return { status: Number(arg.getLiteralValue()), at: call };
      }
    }
  }
  return undefined;
}

function throwIn(node: Node): { exception: string; message?: string; at: Node } | undefined {
  const throwStmt = [node, ...node.getDescendants()].find(Node.isThrowStatement);
  const expr = throwStmt?.getExpression();
  if (throwStmt && expr && Node.isNewExpression(expr)) {
    return { exception: expr.getExpression().getText().split('.').pop()!, message: stringValue(expr.getArguments()[0]), at: throwStmt };
  }
  return undefined;
}

/** Event classes that carry the event name as data, or that are not domain events. */
export const GENERIC_EVENT = /^(Domain|Integration|Outbox|Base|Abstract|Incoming|Outgoing|Application|Cloud|Message|Generic|Custom)?Event$|DomainEvent$|IntegrationEvent$/;

const REPO_TARGET =/(repo|repository|prisma|dao|store|model|db|database|entityManager|em)$/i;
const REPO_METHOD = /^(save|create|insert|update|upsert|delete|remove|destroy|persist|merge|find\w*|get\w*|count|exists\w*|createMany|updateMany|deleteMany)$/;
const EVENT_EMIT = /^(emit|emitAsync|publish|publishAll|dispatch|send|produce|enqueue)$/;
const EVENT_TARGET = /(event|bus|emitter|publisher|producer|queue|broker|outbox|kafka|rabbit|nats|eventBus)/i;

/** Analyses one function-like node and the service methods it reaches. */
export function analyzeBody(fn: Node, ctx: BodyContext): SourceEvidence[] {
  const depth = ctx.depth ?? 0;
  const visited = ctx.visited ?? new Set<string>();
  const key = `${fn.getSourceFile().getFilePath()}:${fn.getPos()}`;
  if (visited.has(key) || depth > MAX_DEPTH) return [];
  visited.add(key);

  const out: SourceEvidence[] = [];
  const handled = new Set<Node>();
  const refs = [ctx.endpointId];
  const base = { extractor: ctx.extractor, references: refs };

  const ifs = fn.getDescendantsOfKind(SyntaxKind.IfStatement) as IfStatement[];
  for (const ifs_ of ifs) {
    const then = ifs_.getThenStatement();
    const status = statusIn(then);
    const thrown = throwIn(then);
    if (!status && !thrown) continue;
    if (status) handled.add(status.at);
    if (thrown) handled.add(thrown.at);
    const code = status?.status ?? (thrown ? EXCEPTION_STATUS[thrown.exception] : undefined);
    if (code !== undefined && code < 400) continue;
    const message = (status ? messageIn(then) : undefined) ?? thrown?.message;
    const condition = ifs_.getExpression().getText().replace(/\s+/g, ' ');
    const { kind, technical } = failureKind(code ?? (thrown && /auth|forbidden|permission/i.test(thrown.exception) ? 403 : undefined));
    out.push(makeEvidence({
      ...base, kind, location: loc(ctx.root, ifs_), confidence: code !== undefined ? 'strong' : 'inferred',
      description: `${message ?? thrown?.exception ?? `status ${code}`} when ${condition}`,
      symbol: thrown?.exception,
      metadata: { condition, status: code, message, exception: thrown?.exception, technical },
      key: `${condition}|${code}|${message ?? ''}`
    }));
  }

  // Unconditional throws at the top level of a handler are rare and say nothing about when they happen: skipped.

  for (const node of fn.getDescendants()) {
    // order.status = 'CANCELLED' / order.state = OrderStatus.Cancelled
    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const left = node.getLeft();
      if (Node.isPropertyAccessExpression(left) && /^(status|state)$/i.test(left.getName())) {
        const value = stateValue(node.getRight());
        if (value) out.push(makeEvidence({ ...base, kind: 'state-value', location: loc(ctx.root, node), confidence: 'strong', symbol: left.getExpression().getText(), description: `${left.getName()} set to ${value}`, metadata: { field: left.getName(), value } }));
      }
    }
    // { status: 'PENDING' } in a created object
    if (Node.isPropertyAssignment(node) && /^(status|state)$/i.test(node.getName())) {
      const parentCall = node.getFirstAncestor(a => Node.isCallExpression(a) || Node.isReturnStatement(a) || Node.isVariableDeclaration(a));
      const value = stateValue(node.getInitializer());
      // A status inside a response body for an error (`res.status(404).json({ status: 'error' })`) is not a domain state.
      if (value && parentCall && !(Node.isCallExpression(parentCall) && /^(json|send|status)$/.test(calleeName(parentCall)))) {
        out.push(makeEvidence({ ...base, kind: 'state-value', location: loc(ctx.root, node), confidence: 'strong', description: `${node.getName()} initialised to ${value}`, metadata: { field: node.getName(), value, initial: true } }));
      }
    }
    if (Node.isNewExpression(node)) {
      const cls = node.getExpression().getText().split('.').pop()!;
      const named = stringValue(node.getArguments()[0]);
      // new DomainEvent('OrderPlaced', …): a generic class named by its first argument.
      if (/Event$/.test(cls) && named && /^[A-Z][A-Za-z0-9]+$/.test(named)) out.push(makeEvidence({ ...base, kind: 'domain-event', location: loc(ctx.root, node), confidence: 'strong', symbol: named, description: `publishes ${named}`, metadata: { event: named } }));
      else if (/[A-Za-z]Event$/.test(cls) && !GENERIC_EVENT.test(cls)) out.push(makeEvidence({ ...base, kind: 'domain-event', location: loc(ctx.root, node), confidence: 'strong', symbol: cls, description: `publishes ${eventName(cls)}`, metadata: { event: eventName(cls) } }));
    }
    if (Node.isCallExpression(node)) {
      if (handled.has(node)) continue;
      const name = calleeName(node);
      const expr = node.getExpression();
      // Success status outside the failure branches.
      if (name === 'status' || name === 'sendStatus' || name === 'code') {
        const arg = node.getArguments()[0];
        if (arg && Node.isNumericLiteral(arg) && Number(arg.getLiteralValue()) < 400 && /\b(res|response|reply|ctx|c)\b/.test(Node.isPropertyAccessExpression(expr) ? expr.getExpression().getText() : '')) {
          out.push(makeEvidence({ ...base, kind: 'success-response', location: loc(ctx.root, node), confidence: 'strong', description: `responds ${arg.getLiteralValue()}`, metadata: { status: Number(arg.getLiteralValue()) } }));
        }
      }
      // Calls to other systems (PLAN-3.3.0-reverse-plus RV-08): HTTP clients and payment/messaging SDKs.
      const integration = externalCall(node, name);
      if (integration) out.push(makeEvidence({ ...base, kind: 'external-integration', location: loc(ctx.root, node), confidence: 'strong', symbol: integration.client, description: integration.description, metadata: integration }));
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const target = expr.getExpression().getText();
      // CQRS (@nestjs/cqrs): commandBus.execute(new PlaceOrderCommand(…)) runs the @CommandHandler(PlaceOrderCommand).
      if (name === 'execute' && /(command|query)Bus$|^this\.bus$/i.test(target)) {
        const created = node.getArguments()[0];
        const cls = created && Node.isNewExpression(created) ? created.getExpression().getText().split('.').pop() : undefined;
        const handler = cls ? cqrsHandlerOf(node, cls) : undefined;
        if (handler) {
          out.push(makeEvidence({ ...base, kind: 'service-call', location: loc(ctx.root, node), confidence: 'strong', symbol: `${handler.getParentOrThrow().getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName() ?? cls}.execute`, description: `dispatches ${cls}`, metadata: { target: cls, method: 'execute', declaredIn: relPath(ctx.root, handler) } }));
          out.push(...analyzeBody(handler, { ...ctx, depth: depth + 1, visited }));
        }
        continue;
      }
      // Events: emitter.emit('order.placed', …) / eventBus.publish(new OrderPlacedEvent())
      if (EVENT_EMIT.test(name) && EVENT_TARGET.test(target)) {
        const first = node.getArguments()[0];
        const lit = stringValue(first);
        if (lit && !/^\//.test(lit)) out.push(makeEvidence({ ...base, kind: 'domain-event', location: loc(ctx.root, node), confidence: 'strong', symbol: lit, description: `publishes ${eventName(lit)}`, metadata: { event: eventName(lit), channel: lit } }));
        continue;
      }
      // Persistence: this.orders.save(…), this.prisma.order.create(…)
      const lastTarget = target.split('.').pop() ?? '';
      const prisma = target.match(/\bprisma\.(\w+)$/);
      if (REPO_METHOD.test(name) && (REPO_TARGET.test(lastTarget) || prisma)) {
        out.push(makeEvidence({ ...base, kind: 'repository-query', location: loc(ctx.root, node), confidence: 'strong', symbol: `${target}.${name}`, description: `${/^(find|get|count|exists)/.test(name) ? 'reads' : 'writes'} ${prisma?.[1] ?? lastTarget}`, metadata: { target, method: name, entity: prisma?.[1], write: !/^(find|get|count|exists)/.test(name) } }));
      }
      // Service calls: follow this.service.method(…) into its declaration.
      if (/^this\.\w+$/.test(target) || /^\w+(Service|UseCase|Handler|Manager)$/i.test(lastTarget)) {
        const decl = expr.getNameNode().getSymbol()?.getDeclarations()?.find(d => Node.isMethodDeclaration(d) || Node.isFunctionDeclaration(d) || Node.isPropertyDeclaration(d));
        const bodyOwner = decl && (Node.isPropertyDeclaration(decl) ? decl.getInitializer() : decl);
        if (bodyOwner && (Node.isMethodDeclaration(bodyOwner) || Node.isFunctionDeclaration(bodyOwner) || Node.isArrowFunction(bodyOwner) || Node.isFunctionExpression(bodyOwner)) && bodyOwner.getBody()) {
          const owner = bodyOwner.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName();
          out.push(makeEvidence({ ...base, kind: 'service-call', location: loc(ctx.root, node), confidence: 'strong', symbol: `${owner ?? lastTarget}.${name}`, description: `calls ${owner ?? lastTarget}.${name}`, metadata: { target: owner ?? lastTarget, method: name, declaredIn: relPath(ctx.root, bodyOwner) } }));
          out.push(...analyzeBody(bodyOwner, { ...ctx, depth: depth + 1, visited }));
        }
      }
    }
  }
  return out;
}

/** The `execute` method of the class decorated `@CommandHandler(<cls>)` or `@QueryHandler(<cls>)`, in the same project. */
export function cqrsHandlerOf(from: Node, cls: string): Node | undefined {
  for (const sf of from.getSourceFile().getProject().getSourceFiles()) {
    for (const c of sf.getClasses()) {
      const d = c.getDecorator('CommandHandler') ?? c.getDecorator('QueryHandler');
      if (d && d.getArguments()[0]?.getText().split('.').pop() === cls) return c.getMethod('execute');
    }
  }
  return undefined;
}

const HTTP_CLIENT = /^(axios|got|ky|superagent|needle|undici|request|this\.(httpService|http|httpClient|apiClient|restClient))$/;
const HTTP_VERBS = /^(get|post|put|patch|delete|head|request|fetch)$/;
const SDK_CLIENT = /^(stripe|twilio|sendgrid|sgMail|mailgun|mailchimp|paypal|braintree|adyen|plaid|ses|sns|s3)$/i;

/** `axios.post(url)`, `fetch(url)`, `this.httpService.get(…)`, `stripe.charges.create(…)`. */
export function externalCall(node: Node, name: string): { client: string; method?: string; url?: string; description: string } | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const expr = node.getExpression();
  const url = stringValue(node.getArguments()[0]);
  const shown = url && /^(https?:)?\/\//.test(url) ? url.replace(/[?#].*$/, '') : undefined;
  if (Node.isIdentifier(expr) && name === 'fetch') return { client: 'fetch', url: shown, description: `HTTP call${shown ? ` to ${shown}` : ''} (fetch)` };
  if (!Node.isPropertyAccessExpression(expr)) return undefined;
  const target = expr.getExpression().getText();
  const client = target.replace(/^this\./, '');
  if (HTTP_CLIENT.test(target) && HTTP_VERBS.test(name)) return { client, method: name.toUpperCase(), url: shown, description: `HTTP ${name.toUpperCase()}${shown ? ` ${shown}` : ''} (${client})` };
  const root = client.split('.')[0];
  if (SDK_CLIENT.test(root)) return { client: root, method: name, description: `${root} ${target.split('.').slice(1).concat(name).join('.')}` };
  return undefined;
}

function stateValue(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  const lit = stringValue(n);
  if (lit !== undefined) return /^[A-Za-z][\w-]{1,40}$/.test(lit) ? lit : undefined;
  // OrderStatus.CANCELLED / Status.Cancelled
  if (Node.isPropertyAccessExpression(n) && /status|state/i.test(n.getExpression().getText())) return n.getName();
  return undefined;
}
