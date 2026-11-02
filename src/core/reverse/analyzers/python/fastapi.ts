/* ==========================================================================
   gherkin-ai-cli - FastAPI adapter for `ghk reverse` (PLAN-3.3.0 R-09,
   experimental). Python through tree-sitter.

   - Routes: @app.get/post/… and @router.get/post/… with the APIRouter
     prefix (and include_router(…, prefix=…)); status_code= on the decorator.
   - Security: Depends(get_current_user)-style dependencies (401) and
     role dependencies (`Depends(require_role("manager"))`, 403); Security().
   - Input: the Pydantic model parameter and its constraints (EmailStr,
     Field(..., min_length=…, gt=…, pattern=…)).
   - Bodies: `if …: raise HTTPException(status_code=404, detail="…")` (also
     status.HTTP_404_NOT_FOUND, custom exceptions by name, JSONResponse
     status codes); states and events; and calls to project functions
     (`services.cancel_order(order)`), followed into their definition.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { isTestFile } from '../../discovery';
import { joinPaths, makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { failureKind } from '../typescript/ts-body';
import { childOfType, childrenOfType, lineRange, ofType, parserFor, unquote, type TSNode } from '../treesitter/loader';
import { exceptionStatusByName } from '../jvm/spring';
import { eventsInText, statesInText } from '../shared/body-text';

const ID = 'python/fastapi';
const MAX_DEPTH = 3;
const VERBS: Record<string, EndpointMetadata['method']> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const FIELD_RULES: Record<string, string> = { min_length: 'minLength', max_length: 'maxLength', gt: 'min', ge: 'min', lt: 'max', le: 'max', pattern: 'pattern', regex: 'pattern', min_items: 'minItems' };

/** status_code=404, status.HTTP_404_NOT_FOUND, HTTPStatus.NOT_FOUND, HTTPException(404, …). */
export function pythonStatus(text: string): number | undefined {
  const m = text.match(/status_code\s*=\s*(\d{3})|HTTP_(\d{3})_|HTTPException\(\s*(\d{3})|JSONResponse\([^)]*status_code\s*=\s*(\d{3})/);
  if (m) return Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
  const named = text.match(/HTTPStatus\.([A-Z_]+)/)?.[1];
  return named ? ({ OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, UNPROCESSABLE_ENTITY: 422 } as Record<string, number>)[named] : undefined;
}

interface PyFunction { name: string; module: string; file: string; node: TSNode; body?: TSNode; decorators: TSNode[]; params: TSNode | null }

const stringOf = (n: TSNode | undefined | null) => (n?.type === 'string' ? unquote(n.text) : undefined);
const kwarg = (args: TSNode | null | undefined, name: string) => childrenOfType(args, 'keyword_argument').find(k => k.childForFieldName('name')?.text === name)?.childForFieldName('value');

function failure(fn: PyFunction, endpointId: string, node: TSNode, condition: string, branch: string): SourceEvidence | undefined {
  const raised = branch.match(/\braise\s+([A-Z]\w*)\s*(?:\(([\s\S]*)\))?/);
  const returned = /\breturn\s+JSONResponse/.test(branch) ? branch : undefined;
  if (!raised && !returned) return undefined;
  const status = raised ? pythonStatus(raised[0]) ?? exceptionStatusByName(raised[1]) : pythonStatus(returned!);
  if (status !== undefined && status < 400) return undefined;
  const message = branch.match(/detail\s*=\s*["']([^"']{4,})["']/)?.[1] ?? branch.match(/["']([^"']{4,})["']/)?.[1];
  const { kind, technical } = failureKind(status);
  return makeEvidence({
    kind, extractor: ID, confidence: status !== undefined ? 'strong' : 'inferred', references: [endpointId], location: { file: fn.file, ...lineRange(node) },
    symbol: raised?.[1], description: `${message ?? raised?.[1] ?? `status ${status}`} when ${condition}`,
    metadata: { condition, status, message, exception: raised?.[1], technical }, key: `${condition}|${status}|${message ?? ''}`
  });
}

function analyzeBody(fn: PyFunction, endpointId: string, functions: PyFunction[], depth: number, visited: Set<string>): SourceEvidence[] {
  const key = `${fn.file}:${fn.node.startIndex}`;
  if (!fn.body || visited.has(key) || depth > MAX_DEPTH) return [];
  visited.add(key);
  const out: SourceEvidence[] = [];
  for (const ifNode of ofType(fn.body, 'if_statement')) {
    const cond = ifNode.childForFieldName('condition');
    const then = ifNode.childForFieldName('consequence');
    if (!cond || !then) continue;
    const e = failure(fn, endpointId, ifNode, cond.text.replace(/\s+/g, ' '), then.text);
    if (e) out.push(e);
  }
  const scope = { text: fn.body.text, startLine: fn.body.startPosition.row + 1, file: fn.file, extractor: ID, endpointId };
  out.push(...statesInText(scope), ...eventsInText(scope));
  for (const call of ofType(fn.body, 'call')) {
    const callee = call.childForFieldName('function');
    if (!callee) continue;
    const [receiver, name] = callee.type === 'attribute' ? [callee.childForFieldName('object')?.text, callee.childForFieldName('attribute')?.text] : [undefined, callee.text];
    if (!name || !/^[a-z_]\w*$/.test(name)) continue;
    // Repository-like calls: orders.save(order), session.add(x), db.commit().
    if (receiver && /^(save|add|delete|remove|update|insert|get|find\w*|filter|query|execute|merge|commit)$/.test(name) && /(repo|repository|session|db|orders?|store|\w+s)$/i.test(receiver) && !functions.some(f => f.name === name && f.module === receiver)) {
      out.push(makeEvidence({ kind: 'repository-query', extractor: ID, confidence: 'inferred', references: [endpointId], location: { file: fn.file, ...lineRange(call) }, symbol: `${receiver}.${name}`, description: `${/^(get|find|filter|query)/.test(name) ? 'reads' : 'writes'} ${receiver}`, metadata: { target: receiver, method: name } }));
      continue;
    }
    // Project functions: services.cancel_order(…) (module services.py) or a function imported by name.
    const target = functions.find(f => f.name === name && f !== fn && (receiver ? f.module === receiver.split('.').pop() : true));
    if (!target || (!receiver && functions.filter(f => f.name === name).length > 1)) continue;
    out.push(makeEvidence({ kind: 'service-call', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: fn.file, ...lineRange(call) }, symbol: `${target.module}.${name}`, description: `calls ${target.module}.${name}`, metadata: { target: target.module, method: name, declaredIn: target.file } }));
    out.push(...analyzeBody(target, endpointId, functions, depth + 1, visited));
  }
  return out;
}

const fastapi: SourceAnalyzer = {
  id: ID,
  language: 'python',
  frameworks: ['fastapi'],
  maturity: 'experimental',
  detect(ctx) {
    return ctx.files.some(f => f.ext === '.py' && !isTestFile(f.rel) && (() => {
      try { return /from fastapi import|import fastapi/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    })());
  },
  async analyze(ctx: AnalysisContext) {
    const parser = await parserFor('python');
    const functions: PyFunction[] = [];
    const models = new Map<string, { file: string; node: TSNode }>();
    const routerPrefix = new Map<string, string>(); // `${module}.${variable}` → prefix
    const includePrefix = new Map<string, string>(); // module → prefix from include_router(module.router, prefix=…)
    for (const f of ctx.files.filter(x => x.ext === '.py' && !isTestFile(x.rel) && !/(^|\/)(migrations|alembic|venv|\.venv)\//.test(x.rel))) {
      let tree;
      try { tree = parser.parse(fs.readFileSync(f.abs, 'utf8')); } catch { continue; }
      if (!tree) continue;
      const module = path.posix.basename(f.rel, '.py');
      for (const def of ofType(tree.rootNode, 'function_definition')) {
        const decorated = def.parent?.type === 'decorated_definition' ? def.parent : undefined;
        functions.push({ name: def.childForFieldName('name')?.text ?? '', module, file: f.rel, node: def, body: def.childForFieldName('body') ?? undefined, decorators: childrenOfType(decorated, 'decorator'), params: def.childForFieldName('parameters') });
      }
      for (const cls of ofType(tree.rootNode, 'class_definition')) {
        if (/BaseModel|BaseSchema|Schema/.test(cls.childForFieldName('superclasses')?.text ?? '')) models.set(cls.childForFieldName('name')?.text ?? '', { file: f.rel, node: cls });
      }
      for (const a of ofType(tree.rootNode, 'assignment')) {
        const right = a.childForFieldName('right');
        if (right?.type === 'call' && /^(APIRouter|FastAPI)$/.test(right.childForFieldName('function')?.text ?? '')) {
          routerPrefix.set(`${module}.${a.childForFieldName('left')?.text}`, stringOf(kwarg(right.childForFieldName('arguments'), 'prefix')) ?? '');
        }
      }
      for (const call of ofType(tree.rootNode, 'call')) {
        if (!/\.include_router$/.test(call.childForFieldName('function')?.text ?? '')) continue;
        const args = call.childForFieldName('arguments');
        const target = args?.namedChildren[0]?.text.split('.')[0];
        const prefix = stringOf(kwarg(args, 'prefix'));
        if (target && prefix) includePrefix.set(target, prefix);
      }
    }

    const out: SourceEvidence[] = [];
    for (const fn of functions) {
      for (const dec of fn.decorators) {
        const call = childOfType(dec, 'call');
        const callee = call?.childForFieldName('function');
        if (callee?.type !== 'attribute') continue;
        const verb = VERBS[callee.childForFieldName('attribute')?.text ?? ''];
        const routerVar = callee.childForFieldName('object')?.text ?? '';
        if (!verb || !routerPrefix.has(`${fn.module}.${routerVar}`)) continue;
        const args = call!.childForFieldName('arguments');
        const route = stringOf(args?.namedChildren[0]) ?? '';
        const p = joinPaths(joinPaths(includePrefix.get(fn.module), routerPrefix.get(`${fn.module}.${routerVar}`)), route);
        const endpoint = makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: { file: fn.file, ...lineRange(fn.node) }, symbol: `${fn.module}.${fn.name}`, description: `${verb} ${p}`, key: `${verb} ${p}`, metadata: { method: verb, path: p, handler: fn.name, owner: fn.module } satisfies EndpointMetadata });
        out.push(endpoint);
        const statusArg = kwarg(args, 'status_code')?.text;
        const declared = statusArg ? pythonStatus(`status_code=${statusArg}`) : undefined;
        out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: declared ? 'strong' : 'inferred', references: [endpoint.id], location: endpoint.location, description: `responds ${declared ?? 200}`, metadata: { status: declared ?? 200 } }));
        // Dependencies: authentication and roles.
        for (const dep of (fn.params?.text ?? '').matchAll(/(?:Depends|Security)\(\s*([\w.]+)(?:\(\s*["']([^"']+)["'])?/g)) {
          if (!/user|auth|token|login|role|permission|admin|scope/i.test(dep[1])) continue;
          const role = dep[2];
          out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: fn.file, ...lineRange(fn.params!) }, description: role ? `requires role ${role}` : `requires ${dep[1]}`, metadata: { roles: role ? [role] : undefined, status: role ? 403 : 401 } }));
        }
        // Pydantic body.
        for (const p2 of fn.params?.namedChildren ?? []) {
          const type = p2?.childForFieldName('type')?.text;
          const model = type ? models.get(type) : undefined;
          if (!model) continue;
          for (const a of ofType(model.node, 'assignment')) {
            const field = a.childForFieldName('left')?.text ?? '';
            const ftype = a.childForFieldName('type')?.text ?? '';
            const right = a.childForFieldName('right');
            const rules: string[] = [];
            if (/EmailStr/.test(ftype)) rules.push('email');
            if (right?.type === 'call' && /Field$/.test(right.childForFieldName('function')?.text ?? '')) {
              const fargs = right.childForFieldName('arguments');
              if (fargs?.namedChildren[0]?.type === 'ellipsis') rules.push('required');
              for (const k of childrenOfType(fargs, 'keyword_argument')) { const r = FIELD_RULES[k.childForFieldName('name')?.text ?? '']; if (r) rules.push(r); }
            }
            for (const rule of [...new Set(rules)]) out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: model.file, ...lineRange(a) }, symbol: `${type}.${field}`, description: `${field} ${rule}`, metadata: { field, rule, status: 422, dto: type } }));
          }
          out.push(makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: model.file, ...lineRange(model.node) }, symbol: type, description: `body ${type}`, metadata: { dto: type } }));
        }
        out.push(...analyzeBody(fn, endpoint.id, functions, 0, new Set()));
      }
    }
    return out;
  }
};

export default fastapi;
