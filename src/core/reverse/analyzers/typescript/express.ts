/* ==========================================================================
   gherkin-ai-cli - Express adapter for `ghk reverse` (PLAN-3.3.0 R-05, beta)

   Routes: `router.post('/orders', auth, handler)`, `app.get(…)`, with the
   prefix of `app.use('/api', router)` when the router is mounted by name.
   Middleware whose name says authentication becomes an authorization rule.
   Inline handlers and named ones (resolved through the type checker) are
   analysed by ts-body.
   ========================================================================== */

import fs from 'fs';
import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import { joinPaths, makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { SourceAnalyzer } from '../../registry';
import { analyzeBody, calleeName, relPath } from './ts-body';
import { packageDeps, tsProject, tsSources } from './project';
import { tsEntryPoints } from './entries';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const AUTH_MIDDLEWARE = /(auth|authenticate|authorize|requireUser|requireLogin|isAuthenticated|ensureLoggedIn|protect|jwt|passport|guard|verifyToken|requireRole|hasRole)/i;

/** Receivers that register routes (`app`, `router`, `ordersRouter`, `api`); `axios.get('/x', cfg)` is a client call, not a route. */
const ROUTER_NAME = /^(app|server|api|router|routes?|\w*(Router|Routes|App))$/i;

const ID = 'typescript/express';

const express: SourceAnalyzer = {
  id: ID,
  language: 'typescript',
  frameworks: ['express'],
  maturity: 'beta',
  detect(ctx) {
    if (packageDeps(ctx.root).has('express')) return true;
    return tsSources(ctx).slice(0, 400).some(f => {
      try { return /from ['"]express['"]|require\(['"]express['"]\)/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    });
  },
  async analyze(ctx) {
    const project = await tsProject(ctx);
    const out: SourceEvidence[] = [];

    // app.use('/api', ordersRouter): prefix by router identifier name.
    const prefixes = new Map<string, string>();
    const routeCalls: CallExpression[] = [];
    // Variables created by express() / express.Router() / Router(): routers whatever their name.
    const routerVars = new Set<string>();
    for (const sf of project.getSourceFiles()) {
      for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (/^(express(\.Router)?|Router|Express\.Router)\s*\(/.test(v.getInitializer()?.getText() ?? '')) routerVars.add(v.getName());
      }
    }
    const isRouter = (name: string) => routerVars.has(name) || ROUTER_NAME.test(name);
    for (const sf of project.getSourceFiles()) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(call);
        const args = call.getArguments();
        const first = args[0];
        if (name === 'use' && first && Node.isStringLiteral(first)) {
          for (const a of args.slice(1)) if (Node.isIdentifier(a)) prefixes.set(a.getText(), first.getLiteralValue());
        }
        if (METHODS.has(name) && first && (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) && first.getLiteralValue().startsWith('/') && args.length >= 2
          && Node.isPropertyAccessExpression(call.getExpression())
          && isRouter((call.getExpression() as any).getExpression().getText())) {
          routeCalls.push(call);
        }
      }
    }

    for (const call of routeCalls) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const routerName = expr.getExpression().getText();
      const args = call.getArguments();
      const rawPath = (args[0] as any).getLiteralValue() as string;
      const method = calleeName(call).toUpperCase() as EndpointMetadata['method'];
      const fullPath = joinPaths(prefixes.get(routerName), rawPath);
      const handlerArg = args[args.length - 1];
      const handlerName = Node.isIdentifier(handlerArg) || Node.isPropertyAccessExpression(handlerArg) ? handlerArg.getText() : undefined;
      const location = { file: relPath(ctx.root, call), startLine: call.getStartLineNumber(), endLine: call.getEndLineNumber() };
      const endpoint = makeEvidence({
        kind: 'http-endpoint', extractor: ID, confidence: 'strong', location,
        symbol: handlerName, description: `${method} ${fullPath}`,
        metadata: { method, path: fullPath, handler: handlerName, owner: routerName } satisfies EndpointMetadata,
        key: `${method} ${fullPath}`
      });
      out.push(endpoint);

      for (const mw of args.slice(1, -1)) {
        const text = mw.getText();
        if (AUTH_MIDDLEWARE.test(text)) {
          out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: location.file, startLine: mw.getStartLineNumber(), endLine: mw.getEndLineNumber() }, description: `requires ${text}`, metadata: { middleware: text, status: 401 } }));
        }
      }

      let body: Node | undefined = handlerArg;
      if (Node.isIdentifier(handlerArg) || Node.isPropertyAccessExpression(handlerArg)) {
        const nameNode = Node.isPropertyAccessExpression(handlerArg) ? handlerArg.getNameNode() : handlerArg;
        const decl = nameNode.getSymbol()?.getDeclarations()?.[0];
        body = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : decl;
        // Imported names resolve to the import specifier: follow the alias.
        if (decl && (Node.isImportSpecifier(decl) || Node.isImportClause(decl))) {
          const aliased = nameNode.getSymbol()?.getAliasedSymbol()?.getDeclarations()?.[0];
          body = aliased && Node.isVariableDeclaration(aliased) ? aliased.getInitializer() : aliased;
        }
      }
      if (body && (Node.isArrowFunction(body) || Node.isFunctionExpression(body) || Node.isFunctionDeclaration(body) || Node.isMethodDeclaration(body))) {
        out.push(...analyzeBody(body, { root: ctx.root, extractor: ID, endpointId: endpoint.id }));
      }
    }
    // Event-bus subscriptions and cron jobs (PLAN-3.3.0-reverse-plus RV-06); decorators are NestJS's.
    out.push(...tsEntryPoints(project, ctx.root, ID, { decorators: false }));
    return out;
  }
};

export default express;
