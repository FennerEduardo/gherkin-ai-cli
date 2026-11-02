/* ==========================================================================
   gherkin-ai-cli - NestJS adapter for `ghk reverse` (PLAN-3.3.0 R-05, beta)

   @Controller('orders') classes and their @Get/@Post/@Put/@Patch/@Delete
   methods are the endpoints; @HttpCode sets the success status (POST 201,
   the rest 200 by default). @UseGuards / @Roles become authorization rules.
   The @Body() DTO class gives the input contract, and its class-validator
   decorators the validation rules. Method bodies and the services they call
   are analysed by ts-body.
   ========================================================================== */

import { Node, SyntaxKind } from 'ts-morph';
import type { ClassDeclaration, Decorator, MethodDeclaration } from 'ts-morph';
import { joinPaths, makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { SourceAnalyzer } from '../../registry';
import { analyzeBody, relPath } from './ts-body';
import fs from 'fs';
import { packageDeps, tsProject, tsSources } from './project';

const ID = 'typescript/nestjs';
const ROUTE_DECORATORS: Record<string, EndpointMetadata['method']> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE' };

/** class-validator decorators → rule (`required` for the presence checks). */
const VALIDATORS: Record<string, string> = {
  IsNotEmpty: 'required', IsDefined: 'required', ArrayNotEmpty: 'required', ArrayMinSize: 'minItems', IsEmail: 'email', IsUUID: 'uuid',
  Min: 'min', Max: 'max', MinLength: 'minLength', MaxLength: 'maxLength', Length: 'length', IsPositive: 'positive', IsInt: 'integer',
  Matches: 'pattern', IsEnum: 'enum', IsIn: 'enum', IsDateString: 'date', IsISO8601: 'date', IsCurrency: 'currency', IsUrl: 'url'
};

const firstStringArg = (d: Decorator): string | undefined => {
  const a = d.getArguments()[0];
  if (!a) return undefined;
  if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) return a.getLiteralValue();
  if (Node.isObjectLiteralExpression(a)) {
    const p = a.getProperty('path');
    const init = p && Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
    if (init && Node.isStringLiteral(init)) return init.getLiteralValue();
  }
  return undefined;
};

function authEvidence(owner: ClassDeclaration | MethodDeclaration, root: string, endpointId: string): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  for (const d of owner.getDecorators()) {
    const name = d.getName();
    if (name === 'UseGuards' || name === 'Roles' || name === 'Auth' || name === 'Authorized' || name === 'Permissions') {
      const args = d.getArguments().map(a => a.getText().replace(/['"`]/g, ''));
      out.push(makeEvidence({
        kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpointId],
        location: { file: relPath(root, d), startLine: d.getStartLineNumber(), endLine: d.getEndLineNumber() },
        description: name === 'UseGuards' ? `guarded by ${args.join(', ')}` : `requires role ${args.join(', ')}`,
        metadata: { guard: name === 'UseGuards' ? args : undefined, roles: name !== 'UseGuards' ? args : undefined, status: name === 'UseGuards' ? 401 : 403 }
      }));
    }
  }
  return out;
}

function dtoEvidence(method: MethodDeclaration, root: string, endpointId: string): SourceEvidence[] {
  const out: SourceEvidence[] = [];
  for (const param of method.getParameters()) {
    if (!param.getDecorator('Body')) continue;
    const typeNode = param.getTypeNode();
    const decl = typeNode?.getType().getSymbol()?.getDeclarations()?.find(Node.isClassDeclaration);
    if (!decl) continue;
    const fields: { name: string; type: string; rules: string[] }[] = [];
    for (const prop of decl.getProperties()) {
      const rules: string[] = [];
      for (const d of prop.getDecorators()) {
        const rule = VALIDATORS[d.getName()];
        if (!rule) continue;
        const arg = d.getArguments()[0]?.getText();
        rules.push(rule);
        out.push(makeEvidence({
          kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpointId],
          location: { file: relPath(root, d), startLine: d.getStartLineNumber(), endLine: d.getEndLineNumber() },
          symbol: `${decl.getName()}.${prop.getName()}`, description: `${prop.getName()} ${rule}${arg && rule !== 'enum' ? ` ${arg}` : ''}`,
          metadata: { field: prop.getName(), rule, param: arg, status: 400, dto: decl.getName() }
        }));
      }
      fields.push({ name: prop.getName(), type: prop.getType().getText(prop), rules });
    }
    out.push(makeEvidence({
      kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpointId],
      location: { file: relPath(root, decl), startLine: decl.getStartLineNumber(), endLine: decl.getEndLineNumber() },
      symbol: decl.getName(), description: `body ${decl.getName()} (${fields.map(f => f.name).join(', ')})`, metadata: { dto: decl.getName(), fields }
    }));
  }
  return out;
}

const nestjs: SourceAnalyzer = {
  id: ID,
  language: 'typescript',
  frameworks: ['nestjs'],
  maturity: 'beta',
  detect(ctx) {
    // By its dependency only: `ghk detect` falls back to nestjs when it recognises nothing.
    if (packageDeps(ctx.root).has('@nestjs/common')) return true;
    return tsSources(ctx).slice(0, 400).some(f => {
      try { return /from ['"]@nestjs\/common['"]/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    });
  },
  async analyze(ctx) {
    const project = await tsProject(ctx);
    const out: SourceEvidence[] = [];
    for (const sf of project.getSourceFiles()) {
      for (const cls of sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
        const ctrl = cls.getDecorator('Controller');
        if (!ctrl) continue;
        const prefix = firstStringArg(ctrl);
        for (const method of cls.getMethods()) {
          const routeDec = method.getDecorators().find(d => ROUTE_DECORATORS[d.getName()]);
          if (!routeDec) continue;
          const verb = ROUTE_DECORATORS[routeDec.getName()];
          const fullPath = joinPaths(prefix, firstStringArg(routeDec));
          const handler = `${cls.getName()}.${method.getName()}`;
          const endpoint = makeEvidence({
            kind: 'http-endpoint', extractor: ID, confidence: 'strong',
            location: { file: relPath(ctx.root, method), startLine: method.getStartLineNumber(), endLine: method.getEndLineNumber() },
            symbol: handler, description: `${verb} ${fullPath}`,
            metadata: { method: verb, path: fullPath, handler: method.getName(), owner: cls.getName() } satisfies EndpointMetadata,
            key: `${verb} ${fullPath}`
          });
          out.push(endpoint);
          const httpCode = method.getDecorator('HttpCode')?.getArguments()[0];
          const status = httpCode && Node.isNumericLiteral(httpCode) ? Number(httpCode.getLiteralValue()) : verb === 'POST' ? 201 : 200;
          out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: httpCode ? 'strong' : 'inferred', references: [endpoint.id], location: endpoint.location, description: `responds ${status}`, metadata: { status } }));
          out.push(...authEvidence(cls, ctx.root, endpoint.id), ...authEvidence(method, ctx.root, endpoint.id));
          out.push(...dtoEvidence(method, ctx.root, endpoint.id));
          out.push(...analyzeBody(method, { root: ctx.root, extractor: ID, endpointId: endpoint.id }));
        }
      }
    }
    return out;
  }
};

export default nestjs;
