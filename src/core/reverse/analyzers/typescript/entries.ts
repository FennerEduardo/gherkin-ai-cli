/* ==========================================================================
   gherkin-ai-cli - TypeScript entry points that are not HTTP
   (PLAN-3.3.0-reverse-plus RV-06), used by the NestJS and Express adapters

   Message handlers:
   - NestJS decorators: @EventPattern, @MessagePattern, @OnEvent,
     @RabbitSubscribe, @SqsMessageHandler, @Process (Bull);
   - `<bus>.on('order.placed', fn)` / `.subscribe(…)` on an event bus,
     emitter, consumer or queue (lifecycle events such as 'error' are not).
   Scheduled jobs:
   - NestJS @Cron, @Interval, @Timeout;
   - node-cron `cron.schedule('0 * * * *', fn)`, node-schedule
     `scheduleJob(…)`, `new CronJob('…', fn)`.
   Each becomes `message-handler` or `scheduled-job` evidence, and the
   handler's body is analysed by ts-body exactly as an endpoint's.
   ========================================================================== */

import { Node, SyntaxKind } from 'ts-morph';
import type { Decorator, Project } from 'ts-morph';
import { makeEvidence, type EntryMetadata, type SourceEvidence } from '../../evidence';
import { analyzeBody, calleeName, eventName, relPath } from './ts-body';
import { rpcEvidence } from '../contracts/graphql-grpc';

const MESSAGE_DECORATORS = new Set(['EventPattern', 'MessagePattern', 'OnEvent', 'RabbitSubscribe', 'SqsMessageHandler', 'Process', 'Subscribe', 'Consumer']);
const SCHEDULE_DECORATORS = new Set(['Cron', 'Interval', 'Timeout']);
const BUS_TARGET = /(event|bus|emitter|consumer|subscriber|queue|broker|kafka|rabbit|amqp|nats|pubsub|sqs|sns|redis|stream|channel|topic)/i;
const LIFECYCLE = /^(error|close|closed|end|finish|connect|connected|connection|disconnect|disconnected|ready|listening|exit|drain|timeout|data|open|reconnect|reconnecting|warning|SIG[A-Z]+|uncaughtException|unhandledRejection)$/;

/** First string argument, or the `routingKey` / `queue` / `name` / `pattern` of an options object. */
function decoratorChannel(d: Decorator): string | undefined {
  const a = d.getArguments()[0];
  if (!a) return undefined;
  if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) return a.getLiteralValue();
  if (Node.isObjectLiteralExpression(a)) {
    for (const key of ['routingKey', 'queue', 'topic', 'name', 'pattern', 'cmd', 'event']) {
      const p = a.getProperty(key);
      const init = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
      if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) return init.getLiteralValue();
    }
  }
  return a.getText().replace(/['"`]/g, '');
}

/** A function argument, or the function an identifier names (also through an import). */
function functionOf(node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    const nameNode = Node.isPropertyAccessExpression(node) ? node.getNameNode() : node;
    let decl = nameNode.getSymbol()?.getDeclarations()?.[0];
    if (decl && (Node.isImportSpecifier(decl) || Node.isImportClause(decl))) decl = nameNode.getSymbol()?.getAliasedSymbol()?.getDeclarations()?.[0];
    const fn = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : decl;
    if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn))) return fn;
  }
  return undefined;
}

export function tsEntryPoints(project: Project, root: string, extractor: string, options: { decorators?: boolean; calls?: boolean } = {}): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  const push = (kind: 'message-handler' | 'scheduled-job', node: Node, meta: EntryMetadata, fn: Node | undefined) => {
    const entry = makeEvidence({
      kind, extractor, confidence: 'strong',
      location: { file: relPath(root, node), startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() },
      symbol: meta.owner && meta.handler ? `${meta.owner}.${meta.handler}` : meta.handler,
      description: kind === 'message-handler' ? `handles ${meta.channel ?? 'messages'}` : `runs on schedule ${meta.schedule ?? ''}`.trim(),
      metadata: meta as unknown as Record<string, unknown>,
      key: `${kind}|${meta.channel ?? meta.schedule ?? ''}|${meta.handler ?? ''}`
    });
    out.push(entry);
    if (fn) out.push(...analyzeBody(fn, { root, extractor, endpointId: entry.id }));
  };

  for (const sf of project.getSourceFiles()) {
    if (options.decorators !== false) {
      for (const cls of sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
        // @nestjs/cqrs: @EventsHandler(OrderPlacedEvent) class ReserveStockWhenOrderPlaced { handle(event) { … } }.
        const eventsHandler = cls.getDecorator('EventsHandler');
        if (eventsHandler) {
          const handle = cls.getMethod('handle');
          for (const arg of eventsHandler.getArguments()) {
            const event = arg.getText().split('.').pop()!;
            push('message-handler', handle ?? cls, { trigger: 'message', channel: eventName(event), handler: cls.getName(), owner: cls.getName() }, handle);
          }
        }
        for (const method of cls.getMethods()) {
          for (const d of method.getDecorators()) {
            const name = d.getName();
            // GraphQL resolvers and gRPC methods (PLAN-3.3.0-reverse-plus RV-14): the same operation the schema declares.
            if ((name === 'Mutation' || name === 'Query') && cls.getDecorator('Resolver')) {
              const opts = d.getArguments().find(a => Node.isObjectLiteralExpression(a));
              const named = opts && Node.isObjectLiteralExpression(opts) ? opts.getProperty('name') : undefined;
              const opName = named && Node.isPropertyAssignment(named) ? named.getInitializer()?.getText().replace(/['"`]/g, '') : undefined;
              const returns = d.getArguments()[0]?.getText().match(/=>\s*\[?\s*(\w+)/)?.[1];
              const entry = rpcEvidence({ protocol: 'graphql', kind: name === 'Mutation' ? 'mutation' : 'query', operation: opName ?? method.getName(), returns, args: [] }, { file: relPath(root, method), startLine: method.getStartLineNumber(), endLine: method.getEndLineNumber() }, extractor, cls.getName(), method.getName());
              out.push(entry, ...analyzeBody(method, { root, extractor, endpointId: entry.id }));
              continue;
            }
            if (name === 'GrpcMethod') {
              const [svc, rpc] = d.getArguments().map(a => a.getText().replace(/['"`]/g, ''));
              if (svc) {
                const operation = rpc ?? method.getName().charAt(0).toUpperCase() + method.getName().slice(1);
                const entry = rpcEvidence({ protocol: 'grpc', kind: /^(Get|List|Find|Search|Count|Watch|Lookup)/.test(operation) ? 'query' : 'mutation', operation, service: svc, args: [] }, { file: relPath(root, method), startLine: method.getStartLineNumber(), endLine: method.getEndLineNumber() }, extractor, cls.getName(), method.getName());
                out.push(entry, ...analyzeBody(method, { root, extractor, endpointId: entry.id }));
              }
              continue;
            }
            if (MESSAGE_DECORATORS.has(name)) push('message-handler', method, { trigger: 'message', channel: decoratorChannel(d), handler: method.getName(), owner: cls.getName() }, method);
            else if (SCHEDULE_DECORATORS.has(name)) push('scheduled-job', method, { trigger: 'schedule', schedule: `${name === 'Cron' ? '' : `${name.toLowerCase()} `}${d.getArguments()[0]?.getText().replace(/['"`]/g, '') ?? ''}`.trim(), handler: method.getName(), owner: cls.getName() }, method);
          }
        }
      }
    }
    if (options.calls !== false) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(call);
        const args = call.getArguments();
        const first = args[0];
        const literal = first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) ? first.getLiteralValue() : undefined;
        const expr = call.getExpression();
        const target = Node.isPropertyAccessExpression(expr) ? expr.getExpression().getText() : '';
        if (/^(on|subscribe|consume|process|handle)$/.test(name) && literal && !LIFECYCLE.test(literal) && BUS_TARGET.test(target) && !/^(process|window|document|socket|ws|req|res|server|app)$/.test(target)) {
          const fn = functionOf(args[args.length - 1]);
          push('message-handler', call, { trigger: 'message', channel: literal, handler: Node.isIdentifier(args[args.length - 1]) ? args[args.length - 1].getText() : undefined, owner: target }, fn);
        } else if ((name === 'schedule' || name === 'scheduleJob') && literal && /cron|schedule/i.test(target || name)) {
          push('scheduled-job', call, { trigger: 'schedule', schedule: literal, handler: Node.isIdentifier(args[args.length - 1]) ? args[args.length - 1].getText() : undefined }, functionOf(args[args.length - 1]));
        }
      }
      for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (nw.getExpression().getText() !== 'CronJob') continue;
        const [first, fnArg] = nw.getArguments();
        const literal = first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) ? first.getLiteralValue() : undefined;
        if (literal) push('scheduled-job', nw, { trigger: 'schedule', schedule: literal, handler: fnArg && Node.isIdentifier(fnArg) ? fnArg.getText() : undefined }, functionOf(fnArg));
      }
    }
  }
  return out;
}
