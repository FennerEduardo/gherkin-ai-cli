/* ==========================================================================
   gherkin-ai-cli - ASP.NET Core adapter for `ghk reverse` (PLAN-3.3.0 R-08,
   experimental). C# through tree-sitter.

   - Controllers: [ApiController]/[Route] classes (or ControllerBase
     subclasses) with [HttpGet]/[HttpPost]/… actions; `[controller]` and
     `[action]` route tokens are resolved.
   - Minimal APIs: app.MapGet/MapPost/… (and MapGroup prefixes), with
     .RequireAuthorization().
   - Security: [Authorize] (401), [Authorize(Roles = "X")] / Policy (403).
   - Input: the [FromBody] (or complex) parameter's class/record and its
     DataAnnotations ([Required], [EmailAddress], [Range], [StringLength]…).
   - Bodies: guarded failures returning NotFound()/BadRequest(…)/Conflict(…)/
     StatusCode(404)/Results.X/Problem(statusCode: …) or throwing (status from
     the exception name, or a ProblemDetails / middleware map); success from
     Ok/Created/CreatedAtAction/Accepted/NoContent; states and events; and the
     services called through injected fields, followed into the class that
     implements the field's interface.
   ========================================================================== */

import fs from 'fs';
import { isTestFile } from '../../discovery';
import { joinPaths, makeEvidence, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { failureKind } from '../typescript/ts-body';
import { childOfType, childrenOfType, lineRange, ofType, parserFor, unquote, type TSNode } from '../treesitter/loader';
import { exceptionStatusByName } from '../jvm/spring';
import { eventsInText, statesInText } from '../shared/body-text';

const ID = 'csharp/aspnet';
const MAX_DEPTH = 3;
const VERBS: Record<string, EndpointMetadata['method']> = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpPatch: 'PATCH', HttpDelete: 'DELETE' };
const MINIMAL: Record<string, EndpointMetadata['method']> = { MapGet: 'GET', MapPost: 'POST', MapPut: 'PUT', MapPatch: 'PATCH', MapDelete: 'DELETE' };
const RESULT_STATUS: Record<string, number> = {
  Ok: 200, Created: 201, CreatedAtAction: 201, CreatedAtRoute: 201, Accepted: 202, AcceptedAtAction: 202, NoContent: 204,
  BadRequest: 400, ValidationProblem: 400, Unauthorized: 401, Forbid: 403, Forbidden: 403, NotFound: 404, Conflict: 409, UnprocessableEntity: 422
};
const VALIDATORS: Record<string, string> = {
  Required: 'required', EmailAddress: 'email', Range: 'min', MinLength: 'minLength', MaxLength: 'maxLength', StringLength: 'maxLength',
  RegularExpression: 'pattern', Phone: 'pattern', Url: 'url', CreditCard: 'pattern'
};

/** First HTTP status named in C#: NotFound(), Results.Conflict(…), StatusCode(404), StatusCodes.Status409Conflict, Problem(statusCode: 409). */
export function csharpStatus(text: string): number | undefined {
  const code = text.match(/StatusCodes\.Status(\d{3})|statusCode:\s*(\d{3})|StatusCode\(\s*(\d{3})|HttpStatusCode\.(\w+)/);
  if (code?.[1] ?? code?.[2] ?? code?.[3]) return Number(code[1] ?? code[2] ?? code[3]);
  if (code?.[4]) return ({ NotFound: 404, BadRequest: 400, Conflict: 409, Unauthorized: 401, Forbidden: 403, Created: 201, OK: 200, NoContent: 204, Accepted: 202, UnprocessableEntity: 422 } as Record<string, number>)[code[4]];
  const result = text.match(/\b(?:Results\.|TypedResults\.)?(Ok|Created|CreatedAtAction|CreatedAtRoute|Accepted|AcceptedAtAction|NoContent|BadRequest|ValidationProblem|Unauthorized|Forbid|NotFound|Conflict|UnprocessableEntity)\s*\(/);
  return result ? RESULT_STATUS[result[1]] : undefined;
}

interface Attr { name: string; strings: string[]; named: Record<string, string>; raw: string; node: TSNode }
interface CsParam { name: string; type: string; attrs: Attr[] }
interface CsMethod { name: string; attrs: Attr[]; params: CsParam[]; body?: TSNode; node: TSNode }
interface CsClass { name: string; kind: string; attrs: Attr[]; bases: string[]; fields: Map<string, string>; properties: CsParam[]; methods: CsMethod[]; file: string; node: TSNode }

const simpleType = (t: string) => t.replace(/[?\s]/g, '').replace(/<.*$/, '').split('.').pop() ?? t;

function attrsOf(node: TSNode | null | undefined): Attr[] {
  const out: Attr[] = [];
  for (const list of childrenOfType(node, 'attribute_list')) {
    for (const a of childrenOfType(list, 'attribute')) {
      const name = (a.childForFieldName('name') ?? a.namedChildren[0])?.text.split('.').pop()?.replace(/Attribute$/, '');
      if (!name) continue;
      const args = childOfType(a, 'attribute_argument_list');
      const strings: string[] = [];
      const named: Record<string, string> = {};
      for (const arg of childrenOfType(args, 'attribute_argument')) {
        const eq = childOfType(arg, 'name_equals', 'name_colon');
        const value = arg.namedChildren[arg.namedChildren.length - 1];
        if (eq && value) named[eq.text.replace(/[=:\s]/g, '')] = value.text;
        else if (value) { const v = unquote(value.text); if (v !== undefined) strings.push(v); }
      }
      out.push({ name, strings, named, raw: args?.text ?? '', node: a });
    }
  }
  return out;
}

function paramsOf(list: TSNode | null | undefined): CsParam[] {
  return childrenOfType(list, 'parameter').map(p => ({ name: p.childForFieldName('name')?.text ?? '', type: simpleType(p.childForFieldName('type')?.text ?? ''), attrs: attrsOf(p) }));
}

function classOf(node: TSNode, file: string): CsClass {
  const fields = new Map<string, string>();
  const properties: CsParam[] = [];
  const methods: CsMethod[] = [];
  const body = node.childForFieldName('body');
  for (const m of body?.namedChildren ?? []) {
    if (!m) continue;
    if (m.type === 'field_declaration') {
      const decl = childOfType(m, 'variable_declaration');
      const type = simpleType(decl?.childForFieldName('type')?.text ?? '');
      for (const v of childrenOfType(decl, 'variable_declarator')) fields.set((v.childForFieldName('name') ?? v.namedChildren[0])?.text ?? '', type);
    }
    if (m.type === 'constructor_declaration') for (const p of paramsOf(m.childForFieldName('parameters'))) fields.set(p.name, p.type);
    if (m.type === 'property_declaration') properties.push({ name: m.childForFieldName('name')?.text ?? '', type: simpleType(m.childForFieldName('type')?.text ?? ''), attrs: attrsOf(m) });
    if (m.type === 'method_declaration') methods.push({ name: m.childForFieldName('name')?.text ?? '', attrs: attrsOf(m), params: paramsOf(m.childForFieldName('parameters')), body: m.childForFieldName('body') ?? childOfType(m, 'block', 'arrow_expression_clause'), node: m });
  }
  // Primary constructor (records, C# 12 classes): its parameters are properties and injected dependencies.
  for (const p of paramsOf(node.childForFieldName('parameters') ?? childOfType(node, 'parameter_list'))) {
    properties.push(p);
    fields.set(p.name, p.type);
  }
  // `_orders` and `orders` name the same injected dependency.
  for (const [k, v] of [...fields]) fields.set(k.replace(/^_/, ''), v);
  const bases = (node.childForFieldName('bases') ?? childOfType(node, 'base_list'))?.namedChildren.map(b => simpleType(b?.text ?? '')) ?? [];
  return { name: node.childForFieldName('name')?.text ?? '', kind: node.type.replace('_declaration', ''), attrs: attrsOf(node), bases, fields, properties, methods, file, node };
}

interface Index { classes: CsClass[]; exceptionStatus: Map<string, number> }

function implementationOf(index: Index, type: string): CsClass | undefined {
  return index.classes.find(c => c.name === type && c.kind !== 'interface') ?? index.classes.find(c => c.kind === 'class' && c.bases.includes(type));
}

interface BodyCtx { index: Index; endpointId: string; owner: CsClass; depth: number; visited: Set<string> }

const loc = (file: string, node: TSNode) => ({ file, ...lineRange(node) });

function failure(b: BodyCtx, node: TSNode, condition: string, branch: string): SourceEvidence | undefined {
  const thrown = branch.match(/\bthrow\s+new\s+([A-Z]\w*)\s*\(([\s\S]*?)\)\s*;?/);
  const status = thrown ? b.index.exceptionStatus.get(thrown[1]) ?? exceptionStatusByName(thrown[1]) ?? csharpStatus(thrown[2]) : csharpStatus(branch);
  if (!thrown && (status === undefined || status < 400)) return undefined;
  if (status !== undefined && status < 400) return undefined;
  const message = branch.match(/"((?:[^"\\]|\\.){4,})"/)?.[1];
  const { kind, technical } = failureKind(status);
  return makeEvidence({
    kind, extractor: ID, confidence: status !== undefined ? 'strong' : 'inferred', references: [b.endpointId], location: loc(b.owner.file, node),
    symbol: thrown?.[1], description: `${message ?? thrown?.[1] ?? `status ${status}`} when ${condition}`,
    metadata: { condition, status, message, exception: thrown?.[1], technical }, key: `${condition}|${status}|${message ?? ''}`
  });
}

function analyzeBody(body: TSNode, b: BodyCtx): SourceEvidence[] {
  const key = `${b.owner.file}:${body.startIndex}`;
  if (b.visited.has(key) || b.depth > MAX_DEPTH) return [];
  b.visited.add(key);
  const out: SourceEvidence[] = [];
  const failureRanges: [number, number][] = [];
  for (const ifNode of ofType(body, 'if_statement')) {
    const cond = ifNode.childForFieldName('condition') ?? ifNode.namedChildren[0];
    const then = ifNode.childForFieldName('consequence') ?? ifNode.namedChildren[1];
    if (!cond || !then) continue;
    const e = failure(b, ifNode, cond.text.replace(/\s+/g, ' '), then.text);
    if (e) { out.push(e); failureRanges.push([then.startIndex, then.endIndex]); }
  }
  // `?? throw new KeyNotFoundException(…)`: when the value is absent.
  for (const t of ofType(body, 'throw_expression')) {
    const coalesce = t.parent;
    if (coalesce && /\?\?/.test(coalesce.text)) {
      const e = failure(b, coalesce, `${coalesce.text.split('??')[0].trim()} is null`, t.text.replace(/^throw\s+/, 'throw '));
      if (e) { out.push(e); failureRanges.push([t.startIndex, t.endIndex]); }
    }
  }
  const inFailure = (n: TSNode) => failureRanges.some(([s, e]) => n.startIndex >= s && n.endIndex <= e);
  const returns = body.type === 'arrow_expression_clause' || body.type.endsWith('lambda_expression') ? [body] : ofType(body, 'return_statement');
  for (const r of returns) {
    if (inFailure(r)) continue;
    const s = csharpStatus(r.text);
    if (s !== undefined && s < 400) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, r), description: `responds ${s}`, metadata: { status: s } }));
  }
  const scope = { text: body.text, startLine: body.startPosition.row + 1, file: b.owner.file, extractor: ID, endpointId: b.endpointId };
  out.push(...statesInText(scope), ...eventsInText(scope));

  for (const call of ofType(body, 'invocation_expression')) {
    const fn = call.childForFieldName('function') ?? call.namedChildren[0];
    if (fn?.type !== 'member_access_expression') continue;
    const receiver = (fn.childForFieldName('expression') ?? fn.namedChildren[0])?.text.replace(/^this\./, '');
    const name = (fn.childForFieldName('name') ?? fn.namedChildren[fn.namedChildren.length - 1])?.text;
    if (!receiver || !name || !/^\w+$/.test(receiver)) continue;
    const type = b.owner.fields.get(receiver) ?? b.owner.fields.get(receiver.replace(/^_/, ''));
    if (!type) continue;
    if (/(Repository|Repo|Store|DbContext|Context)$/.test(type)) {
      if (/^(Add|Update|Remove|Delete|Save|Find|Get|Insert|Upsert|Any|Count|First|Single|Where|List)\w*$/.test(name)) {
        const read = /^(Find|Get|Any|Count|First|Single|Where|List)/.test(name);
        out.push(makeEvidence({ kind: 'repository-query', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${type}.${name}`, description: `${read ? 'reads' : 'writes'} ${type.replace(/^I(?=[A-Z])/, '').replace(/(Repository|Repo|Store|DbContext|Context)$/, '')}`, metadata: { target: type, method: name, write: !read } }));
      }
      continue;
    }
    const target = implementationOf(b.index, type);
    const callee = target?.methods.find(m => m.name === name && m.body);
    if (!target || !callee?.body) continue;
    out.push(makeEvidence({ kind: 'service-call', extractor: ID, confidence: 'strong', references: [b.endpointId], location: loc(b.owner.file, call), symbol: `${target.name}.${name}`, description: `calls ${target.name}.${name}`, metadata: { target: target.name, method: name, declaredIn: target.file } }));
    out.push(...analyzeBody(callee.body, { ...b, owner: target, depth: b.depth + 1 }));
  }
  return out;
}

function securityOf(attrs: Attr[], file: string, endpointId: string): SourceEvidence[] {
  if (attrs.some(a => a.name === 'AllowAnonymous')) return [];
  return attrs.filter(a => a.name === 'Authorize').map(a => {
    const roles = (unquote(a.named.Roles ?? '') ?? '').split(',').map(r => r.trim()).filter(Boolean);
    const policy = unquote(a.named.Policy ?? '') ?? a.strings[0];
    return makeEvidence({
      kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpointId], location: loc(file, a.node),
      description: roles.length ? `requires role ${roles.join(', ')}` : policy ? `requires policy ${policy}` : 'requires an authenticated user',
      metadata: { roles: roles.length ? roles : policy ? [policy] : undefined, status: roles.length || policy ? 403 : 401 }
    });
  });
}

function inputOf(m: CsMethod, index: Index, endpointId: string): SourceEvidence[] {
  const p = m.params.find(x => x.attrs.some(a => a.name === 'FromBody')) ?? m.params.find(x => /^[A-Z]/.test(x.type) && !/^(String|Guid|Int\d*|Boolean|CancellationToken|HttpContext|HttpRequest|DateTime\w*)$/i.test(x.type) && !x.attrs.some(a => /^From(Route|Query|Header|Services|Form)$/.test(a.name)));
  const dto = p ? index.classes.find(c => c.name === p.type) : undefined;
  if (!dto) return [];
  const out: SourceEvidence[] = [];
  for (const prop of dto.properties) for (const a of prop.attrs) {
    const rule = VALIDATORS[a.name];
    if (!rule) continue;
    out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpointId], location: loc(dto.file, a.node), symbol: `${dto.name}.${prop.name}`, description: `${prop.name} ${rule}`, metadata: { field: prop.name, rule, param: a.raw || undefined, status: 400, dto: dto.name } }));
  }
  out.push(makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpointId], location: { file: dto.file, ...lineRange(dto.node) }, symbol: dto.name, description: `body ${dto.name} (${dto.properties.map(x => x.name).join(', ')})`, metadata: { dto: dto.name, fields: dto.properties.map(x => ({ name: x.name, type: x.type })) } }));
  return out;
}

const aspnet: SourceAnalyzer = {
  id: ID,
  language: 'csharp',
  frameworks: ['aspnet-core'],
  maturity: 'beta',
  detect(ctx) {
    return ctx.files.some(f => f.ext === '.cs' && !isTestFile(f.rel) && (() => {
      try { return /\[(ApiController|Http(Get|Post|Put|Patch|Delete))|\.Map(Get|Post|Put|Patch|Delete)\(/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    })());
  },
  async analyze(ctx: AnalysisContext) {
    const parser = await parserFor('c_sharp');
    const files: { rel: string; root: TSNode }[] = [];
    for (const f of ctx.files.filter(x => x.ext === '.cs' && !isTestFile(x.rel) && !/(^|\/)(bin|obj|Migrations)\//.test(x.rel))) {
      try { const t = parser.parse(fs.readFileSync(f.abs, 'utf8')); if (t) files.push({ rel: f.rel, root: t.rootNode }); } catch { /* unreadable */ }
    }
    const classes = files.flatMap(f => ofType(f.root, 'class_declaration', 'record_declaration', 'interface_declaration').map(n => classOf(n, f.rel)));
    // Exception → status maps: ProblemDetails / middleware (`Map<KeyNotFoundException>(… Status404NotFound)`, `KeyNotFoundException => 404`).
    const exceptionStatus = new Map<string, number>();
    for (const f of files) {
      for (const m of f.root.text.matchAll(/Map<(\w+)>\([^;]*?(?:Status(\d{3})|statusCode:\s*(\d{3}))/g)) exceptionStatus.set(m[1], Number(m[2] ?? m[3]));
      for (const m of f.root.text.matchAll(/\b(\w+Exception)\s*(?:=>|:)\s*(?:StatusCodes\.Status|\(int\)HttpStatusCode\.)?(\d{3}|NotFound|BadRequest|Conflict)/g)) {
        exceptionStatus.set(m[1], /^\d+$/.test(m[2]) ? Number(m[2]) : ({ NotFound: 404, BadRequest: 400, Conflict: 409 } as Record<string, number>)[m[2]]);
      }
    }
    const index: Index = { classes, exceptionStatus };
    const out: SourceEvidence[] = [];

    for (const cls of classes) {
      const isController = cls.attrs.some(a => a.name === 'ApiController') || cls.bases.some(b => /^(Controller|ControllerBase)$/.test(b)) || /Controller$/.test(cls.name) && cls.methods.some(m => m.attrs.some(a => VERBS[a.name]));
      if (!isController) continue;
      const controllerToken = cls.name.replace(/Controller$/, '');
      const prefix = (cls.attrs.find(a => a.name === 'Route')?.strings[0] ?? '').replace(/\[controller\]/gi, controllerToken.toLowerCase());
      for (const m of cls.methods) {
        const verbAttr = m.attrs.find(a => VERBS[a.name]);
        if (!verbAttr || !m.body) continue;
        const sub = (verbAttr.strings[0] ?? m.attrs.find(a => a.name === 'Route')?.strings[0] ?? '').replace(/\[action\]/gi, m.name.toLowerCase());
        const p = joinPaths(prefix, sub).replace(/\{(\w+)(?::[^}]+)?\??\}/g, '{$1}');
        const verb = VERBS[verbAttr.name];
        const endpoint = makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: loc(cls.file, m.node), symbol: `${cls.name}.${m.name}`, description: `${verb} ${p}`, key: `${verb} ${p}`, metadata: { method: verb, path: p, handler: m.name.replace(/Async$/, ''), owner: cls.name } satisfies EndpointMetadata });
        out.push(endpoint);
        out.push(...securityOf([...cls.attrs, ...m.attrs], cls.file, endpoint.id), ...inputOf(m, index, endpoint.id));
        const body = analyzeBody(m.body, { index, endpointId: endpoint.id, owner: cls, depth: 0, visited: new Set() });
        out.push(...body);
        if (!body.some(e => e.kind === 'success-response')) out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location: endpoint.location, description: 'responds 200', metadata: { status: 200 } }));
      }
    }

    // Minimal APIs: app.MapPost("/x", handler), groups from MapGroup("/prefix").
    for (const f of files) {
      const groups = new Map<string, string>();
      for (const m of f.root.text.matchAll(/\b(?:var|const)?\s*(\w+)\s*=\s*(\w+)\.MapGroup\(\s*"([^"]*)"\s*\)/g)) groups.set(m[1], joinPaths(groups.get(m[2]) ?? '', m[3]));
      for (const call of ofType(f.root, 'invocation_expression')) {
        const fn = call.childForFieldName('function') ?? call.namedChildren[0];
        if (fn?.type !== 'member_access_expression') continue;
        const verbName = (fn.childForFieldName('name') ?? fn.namedChildren[fn.namedChildren.length - 1])?.text ?? '';
        const verb = MINIMAL[verbName];
        if (!verb) continue;
        const args = (call.childForFieldName('arguments') ?? childOfType(call, 'argument_list'))?.namedChildren.filter((a): a is TSNode => Boolean(a)) ?? [];
        const route = args[0] ? unquote(args[0].text) : undefined;
        if (route === undefined) continue;
        const receiver = (fn.childForFieldName('expression') ?? fn.namedChildren[0])?.text ?? '';
        const p = joinPaths(groups.get(receiver), route).replace(/\{(\w+)(?::[^}]+)?\??\}/g, '{$1}');
        const owner: CsClass = { name: 'Program', kind: 'class', attrs: [], bases: [], fields: new Map(), properties: [], methods: [], file: f.rel, node: f.root };
        const endpoint = makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: loc(f.rel, call), description: `${verb} ${p}`, key: `${verb} ${p}`, metadata: { method: verb, path: p } satisfies EndpointMetadata });
        out.push(endpoint);
        // .RequireAuthorization(…) chained on the call.
        const chain = call.parent?.parent?.type === 'invocation_expression' ? call.parent.parent.text : '';
        if (/RequireAuthorization\(\s*\)/.test(chain)) out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: loc(f.rel, call), description: 'requires an authenticated user', metadata: { status: 401 } }));
        const policy = chain.match(/RequireAuthorization\(\s*"([^"]+)"/)?.[1];
        if (policy) out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: loc(f.rel, call), description: `requires policy ${policy}`, metadata: { roles: [policy], status: 403 } }));
        const handler = args[1];
        if (handler) out.push(...analyzeBody(handler, { index, endpointId: endpoint.id, owner, depth: 0, visited: new Set() }));
      }
    }
    return out;
  }
};

export default aspnet;
