/* ==========================================================================
   gherkin-ai-cli - Go HTTP adapter for `ghk reverse` (PLAN-3.3.0 R-10,
   experimental): chi, gin, echo and net/http (Go 1.22 method patterns),
   through tree-sitter.

   - Routes: r.Get/Post/… (chi), r.GET/POST/… (gin, echo),
     mux.HandleFunc("POST /orders/{id}", …); prefixes from chi
     r.Route("/x", func(r chi.Router) {…}) and gin/echo Group("/x").
   - Security: auth middleware in the same group (r.Use(RequireAuth),
     .With(Auth), group.Use(AuthMiddleware())).
   - Input: the struct the handler decodes into and its `validate:"…"` tags.
   - Bodies: guarded failures (http.Error(w, "…", http.StatusNotFound),
     c.JSON(http.StatusConflict, …), echo.NewHTTPError(…)); a sentinel
     error (`errors.Is(err, orders.ErrNotPending)`) is linked to the
     service condition that returns it (`if o.Status != "PENDING" { return
     nil, ErrNotPending }`), so state guards are recovered; success status;
     states and events; and the service methods the handler calls.
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { joinPaths, makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { failureKind } from '../typescript/ts-body';
import { childOfType, lineRange, ofType, parserFor, unquote, type TSNode } from '../treesitter/loader';
import { eventsInText, statesInText } from '../shared/body-text';

const ID = 'go/http';
const MAX_DEPTH = 3;
const VERBS: Record<string, EndpointMetadata['method']> = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE'
};
const GO_STATUS: Record<string, number> = {
  OK: 200, Created: 201, Accepted: 202, NoContent: 204, BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409,
  Gone: 410, PreconditionFailed: 412, UnprocessableEntity: 422, TooManyRequests: 429, InternalServerError: 500, BadGateway: 502, ServiceUnavailable: 503
};
const TAG_RULES: Record<string, string> = { required: 'required', email: 'email', gt: 'min', gte: 'min', min: 'min', lt: 'max', lte: 'max', max: 'max', len: 'length', url: 'url', uuid: 'uuid', oneof: 'enum', e164: 'pattern' };
const AUTH = /auth|jwt|token|session|login|protect|require(?:User|Role)|role|permission|guard/i;

/** http.StatusNotFound, StatusCode 404 in c.JSON(404, …) / NewHTTPError(404, …). */
export function goStatus(text: string): number | undefined {
  const named = text.match(/\bhttp\.Status(\w+)/);
  if (named && GO_STATUS[named[1]]) return GO_STATUS[named[1]];
  const numeric = text.match(/\b(?:JSON|AbortWithStatus\w*|NewHTTPError|WriteHeader|String|Status|NoContent)\(\s*([1-5]\d\d)\b/);
  return numeric ? Number(numeric[1]) : undefined;
}

interface GoFunc { name: string; receiver?: string; file: string; node: TSNode; body?: TSNode }

function failure(fn: GoFunc, endpointId: string, node: TSNode, condition: string, branch: string): SourceEvidence | undefined {
  if (!/\b(http\.Error|WriteHeader|JSON|AbortWith\w*|NewHTTPError|Error\(|Status\()/.test(branch)) return undefined;
  const status = goStatus(branch);
  if (status === undefined || status < 400) return undefined;
  const message = branch.match(/"([^"\\]{4,})"/)?.[1];
  const { kind, technical } = failureKind(status);
  return makeEvidence({
    kind, extractor: ID, confidence: 'strong', references: [endpointId], location: { file: fn.file, ...lineRange(node) },
    description: `${message ?? `status ${status}`} when ${condition}`, metadata: { condition, status, message, technical }, key: `${condition}|${status}|${message ?? ''}`
  });
}

function analyzeBody(fn: GoFunc, endpointId: string, funcs: GoFunc[], sentinels: Map<string, string>, depth: number, visited: Set<string>): SourceEvidence[] {
  const key = `${fn.file}:${fn.node.startIndex}`;
  if (!fn.body || visited.has(key) || depth > MAX_DEPTH) return [];
  visited.add(key);
  const out: SourceEvidence[] = [];
  const failureRanges: [number, number][] = [];
  for (const ifNode of ofType(fn.body, 'if_statement')) {
    const cond = ifNode.childForFieldName('condition');
    const then = ifNode.childForFieldName('consequence');
    if (!cond || !then) continue;
    let condition = cond.text.replace(/\s+/g, ' ');
    // errors.Is(err, orders.ErrNotPending) → the service condition behind the sentinel.
    const sentinel = condition.match(/\b(Err\w+)\b/)?.[1];
    if (sentinel && sentinels.has(sentinel)) condition = `${condition} (${sentinels.get(sentinel)})`;
    const e = failure(fn, endpointId, ifNode, condition, then.text);
    if (e) { out.push(e); failureRanges.push([then.startIndex, then.endIndex]); }
  }
  const inFailure = (n: TSNode) => failureRanges.some(([s, e]) => n.startIndex >= s && n.endIndex <= e);
  for (const call of ofType(fn.body, 'call_expression')) {
    if (inFailure(call)) continue;
    const text = call.text;
    if (/\b(WriteHeader|JSON|Status|NoContent|String)\(/.test(text.split('(')[0] + '(')) {
      const s = goStatus(text);
      if (s !== undefined && s < 400) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: fn.file, ...lineRange(call) }, description: `responds ${s}`, metadata: { status: s } }));
    }
  }
  const scope = { text: fn.body.text, startLine: fn.body.startPosition.row + 1, file: fn.file, extractor: ID, endpointId };
  out.push(...statesInText(scope), ...eventsInText(scope));
  // Methods the handler calls (h.svc.Cancel(…), s.repo.Save(…)): followed when one project method has that name.
  for (const call of ofType(fn.body, 'call_expression')) {
    const f = call.childForFieldName('function');
    if (f?.type !== 'selector_expression') continue;
    const name = f.childForFieldName('field')?.text;
    const operand = f.childForFieldName('operand')?.text ?? '';
    if (!name || /^(http|json|errors|fmt|strconv|time|context|log|chi|c|w|r|ctx)$/.test(operand)) continue;
    if (/(repo|store|db|repository)$/i.test(operand.split('.').pop() ?? '') && /^(Save|Get|Find|Create|Update|Delete|Insert|List)\w*$/.test(name)) {
      out.push(makeEvidence({ kind: 'repository-query', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: fn.file, ...lineRange(call) }, symbol: `${operand}.${name}`, description: `${/^(Get|Find|List)/.test(name) ? 'reads' : 'writes'} ${operand}`, metadata: { target: operand, method: name } }));
      continue;
    }
    const candidates = funcs.filter(g => g.name === name && g.receiver && g !== fn);
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    out.push(makeEvidence({ kind: 'service-call', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: fn.file, ...lineRange(call) }, symbol: `${target.receiver}.${name}`, description: `calls ${target.receiver}.${name}`, metadata: { target: target.receiver, method: name, declaredIn: target.file } }));
    out.push(...analyzeBody(target, endpointId, funcs, sentinels, depth + 1, visited));
  }
  return out;
}

const goHttp: SourceAnalyzer = {
  id: ID,
  language: 'go',
  frameworks: ['chi', 'gin', 'echo', 'net/http'],
  maturity: 'experimental',
  detect(ctx) {
    return ctx.files.some(f => f.ext === '.go' && !isTestFile(f.rel) && (() => {
      try { return /go-chi\/chi|gin-gonic\/gin|labstack\/echo|\.HandleFunc\(\s*"(GET|POST|PUT|PATCH|DELETE) /.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    })());
  },
  async analyze(ctx: AnalysisContext) {
    const parser = await parserFor('go');
    const roots: { rel: string; root: TSNode }[] = [];
    for (const f of ctx.files.filter(x => x.ext === '.go' && !isTestFile(x.rel) && !/(^|\/)vendor\//.test(x.rel))) {
      try { const t = parser.parse(fs.readFileSync(f.abs, 'utf8')); if (t) roots.push({ rel: f.rel, root: t.rootNode }); } catch { /* unreadable */ }
    }
    const funcs: GoFunc[] = [];
    const sentinels = new Map<string, string>();
    const structs = new Map<string, { file: string; node: TSNode }>();
    for (const { rel, root } of roots) {
      for (const d of ofType(root, 'function_declaration', 'method_declaration')) {
        const receiver = d.type === 'method_declaration' ? d.childForFieldName('receiver')?.text.match(/\*?(\w+)\s*\)$/)?.[1] : undefined;
        funcs.push({ name: d.childForFieldName('name')?.text ?? '', receiver, file: rel, node: d, body: d.childForFieldName('body') ?? undefined });
      }
      for (const ts of ofType(root, 'type_spec')) if (ts.childForFieldName('type')?.type === 'struct_type') structs.set(ts.childForFieldName('name')?.text ?? '', { file: rel, node: ts });
      // `if cond { return …, ErrX }` → the condition behind each sentinel error.
      for (const ifNode of ofType(root, 'if_statement')) {
        const then = ifNode.childForFieldName('consequence')?.text ?? '';
        const err = then.match(/return\b[^\n]*\b(Err\w+)\b/)?.[1];
        const cond = ifNode.childForFieldName('condition')?.text;
        if (err && cond && !sentinels.has(err)) sentinels.set(err, cond.replace(/\s+/g, ' '));
      }
    }

    const out: SourceEvidence[] = [];
    for (const { rel, root } of roots) {
      // gin/echo groups: v1 := r.Group("/v1"); a group of a group adds both prefixes.
      const groups = new Map<string, string>();
      for (const m of root.text.matchAll(/(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g)) groups.set(m[1], joinPaths(groups.get(m[2]) ?? '', m[3]));
      for (const call of ofType(root, 'call_expression')) {
        const f = call.childForFieldName('function');
        if (f?.type !== 'selector_expression') continue;
        const method = f.childForFieldName('field')?.text ?? '';
        const operand = f.childForFieldName('operand');
        const args = call.childForFieldName('arguments')?.namedChildren.filter((a): a is TSNode => Boolean(a)) ?? [];
        const first = args[0] && /string_literal$/.test(args[0].type) ? unquote(args[0].text) : undefined;
        if (first === undefined) continue;
        let verb = VERBS[method];
        let route = first;
        if (!verb && /^Handle(Func)?$/.test(method)) {
          const m = first.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/);
          if (!m) continue;
          verb = m[1] as EndpointMetadata['method'];
          route = m[2];
        }
        if (!verb || !route.startsWith('/') || args.length < 2) continue;
        // chi r.Route("/orders", func(r chi.Router) { … }) prefixes, innermost last; gin/echo group variables.
        const prefixes: string[] = [];
        const auth: string[] = [];
        for (let n: TSNode | null = call.parent; n; n = n.parent) {
          if (n.type === 'func_literal') {
            const routeCall = n.parent?.parent;
            const rf = routeCall?.childForFieldName('function');
            const ra = routeCall?.childForFieldName('arguments')?.namedChildren[0];
            if (rf?.type === 'selector_expression' && /^(Route|Group)$/.test(rf.childForFieldName('field')?.text ?? '') && ra && /string_literal$/.test(ra.type)) prefixes.unshift(unquote(ra.text) ?? '');
            for (const use of (childOfType(n, 'block')?.text ?? '').matchAll(/\.(?:Use|With)\(([^)]*)\)/g)) if (AUTH.test(use[1])) auth.push(use[1]);
          }
        }
        const groupVar = operand?.text ?? '';
        const chained = operand?.text.match(/\.With\(([^)]*)\)/)?.[1];
        if (chained && AUTH.test(chained)) auth.push(chained);
        for (const use of root.text.matchAll(new RegExp(`\\b${groupVar.replace(/\W/g, '')}\\.Use\\(([^)]*)\\)`, 'g'))) if (AUTH.test(use[1])) auth.push(use[1]);
        const p = joinPaths(joinPaths(groups.get(groupVar), prefixes.join('/')), route).replace(/:(\w+)/g, '{$1}');
        const handler = args[args.length - 1];
        const handlerName = handler.type === 'selector_expression' ? handler.childForFieldName('field')?.text : handler.type === 'identifier' ? handler.text : undefined;
        const endpoint = makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: { file: rel, ...lineRange(call) }, symbol: handlerName, description: `${verb} ${p}`, key: `${verb} ${p}`, metadata: { method: verb, path: p, handler: handlerName } satisfies EndpointMetadata });
        out.push(endpoint);
        for (const a of [...new Set(auth)]) out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: rel, ...lineRange(call) }, description: `requires ${a.trim()}`, metadata: { middleware: a.trim(), status: 401 } }));
        const target = handler.type === 'func_literal' ? { name: 'handler', file: rel, node: handler, body: handler.childForFieldName('body') ?? undefined } as GoFunc
          : funcs.filter(g => g.name === handlerName).length === 1 ? funcs.find(g => g.name === handlerName) : undefined;
        if (!target) continue;
        // Decoded input: var req T / Decode(&req) / ShouldBindJSON(&req) → T's validate tags.
        const bodyText = target.body?.text ?? '';
        const varName = bodyText.match(/(?:Decode|Bind\w*|ShouldBind\w*)\(\s*&(\w+)\s*\)/)?.[1];
        const type = varName ? bodyText.match(new RegExp(`var\\s+${varName}\\s+(\\w+)|${varName}\\s*:=\\s*&?(\\w+)\\{`))?.slice(1).find(Boolean) : undefined;
        const st = type ? structs.get(type) : undefined;
        if (st) {
          for (const fm of st.node.text.matchAll(/^\s*(\w+)\s+[\w.*[\]]+\s+`[^`]*validate:"([^"]+)"[^`]*`/gm)) {
            for (const tag of fm[2].split(',')) {
              const rule = TAG_RULES[tag.split('=')[0]];
              if (rule) out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: st.file, ...lineRange(st.node) }, symbol: `${type}.${fm[1]}`, description: `${fm[1]} ${rule}`, metadata: { field: fm[1], rule, status: 400, dto: type }, key: `${type}.${fm[1]}.${tag}` }));
            }
          }
        }
        const body = analyzeBody(target, endpoint.id, funcs, sentinels, 0, new Set());
        out.push(...body);
        if (!body.some(e => e.kind === 'success-response')) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location: endpoint.location, description: 'responds 200', metadata: { status: 200 } }));
      }
    }
    return out;
  }
};

export default goHttp;
