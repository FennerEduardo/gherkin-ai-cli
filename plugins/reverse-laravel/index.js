'use strict';
/* ==========================================================================
   @gherkin-ai/reverse-laravel: Laravel for `ghk reverse` (plugin API 2,
   beta: F1 0.93 on the Laravel RealWorld app). Official plugin, kept out of the CLI package so its PHP
   grammar does not weigh on everyone.

   - Routes (tree-sitter-php): `Route::get/post/put/patch/delete(...)` and
     `Route::apiResource/apiResources/resource`, with the prefixes and
     middleware of every enclosing `->prefix()->middleware()->group(...)`
     or `Route::group([...], ...)`, `->only()/->except()`, and the `/api`
     prefix of routes/api.php.
   - Handlers: `[OrderController::class, 'cancel']`, `'OrderController@cancel'`
     or a closure.
   - Security: `auth`, `auth:sanctum`, `auth:api` (401); `can:`, `role:`,
     `ability:` (403).
   - Bodies (patterns): `abort(404, '…')`, `abort_if/abort_unless`,
     `throw new …Exception`, `if (…) return response()->json(…, 409)`;
     states written (`$order->status = 'PAID'`, `->update(['status' => …])`);
     events (`event(new OrderPaid(…))`, `OrderPaid::dispatch(…)`); statuses.
   - Input: the FormRequest the action takes, and its `rules()`.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ID = 'laravel/routes';
const VERBS = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const RESOURCE_ACTIONS = [['index', 'GET', false], ['store', 'POST', false], ['show', 'GET', true], ['update', 'PUT', true], ['update', 'PATCH', true], ['destroy', 'DELETE', true]];
const EXCEPTION_STATUS = { ModelNotFoundException: 404, NotFoundHttpException: 404, AuthorizationException: 403, AccessDeniedHttpException: 403, AuthenticationException: 401, ValidationException: 422, ConflictHttpException: 409, UnprocessableEntityHttpException: 422, BadRequestHttpException: 400 };
const RULES = { required: 'required', email: 'email', min: 'min', max: 'max', integer: 'integer', numeric: 'min', uuid: 'uuid', date: 'date', in: 'enum', regex: 'pattern', url: 'url', unique: 'unique', confirmed: 'required' };

const unquote = s => s && s.replace(/^['"]|['"]$/g, '');
const singular = w => (/ies$/.test(w) ? w.slice(0, -3) + 'y' : /(ss|us)$/.test(w) ? w : /(sses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, ''));
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

function stringsOf(args) {
  return (args ? args.namedChildren : []).map(a => a && a.namedChildren[0]).filter(Boolean);
}

/** Prefixes and middleware from a chain such as `Route::middleware('auth')->prefix('v1')->group(` or `Route::group(['prefix' => 'v1'], …)`. */
function chainOptions(text) {
  const prefix = [...text.matchAll(/(?:->|::)prefix\(\s*['"]([^'"]*)['"]\s*\)|['"]prefix['"]\s*=>\s*['"]([^'"]*)['"]/g)].map(m => m[1] ?? m[2]);
  const middleware = [...text.matchAll(/(?:->|::)middleware\(\s*(\[[^\]]*\]|['"][^'"]*['"])\s*\)|['"]middleware['"]\s*=>\s*(\[[^\]]*\]|['"][^'"]*['"])/g)].flatMap(m => (m[1] ?? m[2]).match(/['"][^'"]+['"]/g) || []).map(unquote);
  return { prefix, middleware };
}

function joinPath(...parts) {
  const p = parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '');
  return p.startsWith('/') ? p : `/${p}`;
}

/** Laravel `{order}` / `{order?}` → `{order}`. */
const normalise = (sdk, p) => sdk.normalisePath(p.replace(/\{(\w+)\?\}/g, '{$1}'));

function controllerIndex(files) {
  const index = new Map();
  for (const f of files) {
    if (!/\.php$/.test(f.rel) || !/Controllers?\//.test(f.rel)) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const cls = text.match(/class\s+(\w+)/);
    if (!cls) continue;
    const methods = new Map();
    for (const m of text.matchAll(/function\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g)) {
      let depth = 1, i = m.index + m[0].length;
      while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
      methods.set(m[1], { params: m[2], body: text.slice(m.index + m[0].length, i - 1), offset: m.index + m[0].length, line: lineOf(text, m.index) });
    }
    index.set(cls[1], { file: f.rel, text, methods });
  }
  return index;
}

function formRequests(files) {
  const out = new Map();
  for (const f of files) {
    if (!/\.php$/.test(f.rel)) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const cls = text.match(/class\s+(\w+)\s+extends\s+FormRequest/);
    if (!cls) continue;
    const rules = text.match(/function\s+rules\s*\([^)]*\)[^{]*\{[\s\S]*?return\s*\[([\s\S]*?)\];/);
    if (!rules) continue;
    const start = rules.index + rules[0].indexOf(rules[1]);
    const fields = [];
    for (const r of rules[1].matchAll(/['"]([\w.*]+)['"]\s*=>\s*(\[[^\]]*\]|['"][^'"]*['"])/g)) {
      const list = r[2].startsWith('[') ? (r[2].match(/['"][^'"]+['"]/g) || []).map(unquote) : unquote(r[2]).split('|');
      fields.push({ name: r[1], line: lineOf(text, start + r.index), rules: list.map(x => { const [n, arg] = x.split(':'); return { rule: RULES[n], param: arg }; }).filter(x => x.rule) });
    }
    out.set(cls[1], { file: f.rel, line: lineOf(text, cls.index), fields });
  }
  return out;
}

/** Guarded failures, states, events and the success status in a PHP method body. */
function bodyEvidence(sdk, file, fileText, body, endpoint) {
  const out = [];
  const at = offset => lineOf(fileText, body.offset + offset);
  const ev = (kind, offset, description, metadata, key) => out.push(sdk.makeEvidence({ kind, extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file, startLine: at(offset), endLine: at(offset) }, description, metadata, key }));
  const text = body.body;
  for (const m of text.matchAll(/abort(_if|_unless)?\(\s*(?:([^,]+?),\s*)?(\d{3})(?:\s*,\s*['"]([^'"]+)['"])?/g)) {
    const status = Number(m[3]);
    const condition = m[1] ? `${m[1] === '_unless' ? '!' : ''}(${(m[2] || '').trim()})` : undefined;
    ev(status === 401 || status === 403 ? 'authorization-rule' : 'error-condition', m.index, `${m[4] || `status ${status}`}${condition ? ` when ${condition}` : ''}`, { status, message: m[4], condition }, `abort|${status}|${m[4] || ''}|${condition || ''}`);
  }
  for (const m of text.matchAll(/if\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{?\s*(?:return\s+response\(\)->json\(([\s\S]*?),\s*(\d{3})\s*\)|throw\s+new\s+(\w+)\(\s*(?:['"]([^'"]*)['"])?)/g)) {
    const status = m[3] ? Number(m[3]) : EXCEPTION_STATUS[m[4]] || (/NotFound/.test(m[4] || '') ? 404 : undefined);
    if (status === undefined || status < 400) continue;
    const message = m[5] || (m[2] && (m[2].match(/['"](?:message|error|errors)['"]\s*=>\s*['"]([^'"]+)['"]/) || [])[1]);
    ev(status === 401 || status === 403 ? 'authorization-rule' : 'error-condition', m.index, `${message || `status ${status}`} when ${m[1].trim()}`, { status, message, condition: m[1].trim(), technical: status >= 500 }, `if|${status}|${message || ''}|${m[1].trim()}`);
  }
  for (const m of text.matchAll(/->status\s*=\s*['"]([A-Za-z][\w-]*)['"]|['"]status['"]\s*=>\s*['"]([A-Za-z][\w-]*)['"]/g)) ev('state-value', m.index, `status ${m[1] ? 'set to' : 'written as'} ${m[1] || m[2]}`, { field: 'status', value: m[1] || m[2], initial: !m[1] && /create\(|new\s/.test(text.slice(Math.max(0, m.index - 200), m.index)) }, `state|${m[1] || m[2]}|${m.index}`);
  for (const m of text.matchAll(/event\(\s*new\s+(\w+)\(|(\w+)::dispatch\(|broadcast\(\s*new\s+(\w+)\(/g)) {
    const cls = m[1] || m[2] || m[3];
    if (/Job$/.test(cls) && m[2]) continue;
    const name = cls.replace(/Event$/, '');
    ev('domain-event', m.index, `publishes ${name}`, { event: name }, `event|${name}|${m.index}`);
  }
  const ok = text.match(/response\(\)->json\([\s\S]*?,\s*(2\d\d)\s*\)|->setStatusCode\(\s*(2\d\d)\s*\)|response\(\)->noContent\(\)/);
  if (ok) ev('success-response', ok.index, `responds ${ok[1] || ok[2] || 204}`, { status: Number(ok[1] || ok[2] || 204) }, 'success');
  return out;
}

const laravel = {
  id: ID,
  language: 'php',
  frameworks: ['laravel'],
  maturity: 'beta',
  detect: ctx => ctx.files.some(f => /(^|\/)routes\/[\w-]+\.php$/.test(f.rel)),
  analyze: async ctx => {
    const sdk = ctx.sdk;
    const parser = await sdk.loadGrammar(path.join(__dirname, 'grammar', 'tree-sitter-php.wasm'));
    const controllers = controllerIndex(ctx.files);
    const requests = formRequests(ctx.files);
    const out = [];
    const seen = new Set();
    for (const f of ctx.files.filter(x => /(^|\/)routes\/[\w-]+\.php$/.test(x.rel) && !sdk.isTestFile(x.rel))) {
      let text;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const tree = parser.parse(text);
      if (!tree) continue;
      const filePrefix = /(^|\/)routes\/api\.php$/.test(f.rel) ? 'api' : '';
      for (const call of sdk.tree.ofType(tree.rootNode, 'scoped_call_expression')) {
        const names = call.namedChildren.filter(n => n && n.type === 'name');
        if (!names[0] || names[0].text !== 'Route') continue;
        const method = names[1] && names[1].text;
        const isResource = /^(apiResource|resource|apiResources)$/.test(method || '');
        if (!VERBS[method] && !isResource && method !== 'match' && method !== 'any') continue;
        // Enclosing groups: closures passed to ->group(...) or Route::group([...], ...).
        const prefixes = [];
        const middleware = [];
        for (let n = call.parent; n; n = n.parent) {
          if (n.type === 'anonymous_function_creation_expression' || n.type === 'arrow_function') {
            const holder = n.parent && n.parent.parent && n.parent.parent.parent; // argument → arguments → call
            if (holder && /call_expression$/.test(holder.type)) { const o = chainOptions(holder.text.slice(0, holder.text.indexOf('function') > 0 ? holder.text.indexOf('function') : holder.text.length)); prefixes.unshift(...o.prefix); middleware.push(...o.middleware); }
          }
        }
        // Chained on the route itself: Route::get(...)->middleware('auth'), ->only([...]).
        let chain = call;
        while (chain.parent && chain.parent.type === 'member_call_expression') chain = chain.parent;
        const own = chainOptions(chain.text.slice(call.text.length));
        middleware.push(...own.middleware);
        const allArgs = stringsOf(call.namedChildren.find(n => n && n.type === 'arguments'));
        // Route::match(['put', 'patch'], 'user', …): the verbs come first.
        const matchVerbs = method === 'match' && allArgs[0] && allArgs[0].type === 'array_creation_expression' ? (allArgs[0].text.match(/['"](\w+)['"]/g) || []).map(v => VERBS[unquote(v).toLowerCase()]).filter(Boolean) : undefined;
        const args = matchVerbs ? allArgs.slice(1) : allArgs;
        const routeArg = args[0] && args[0].type === 'string' ? unquote(args[0].text) : undefined;
        if (routeArg === undefined) continue;
        const handlerArg = args[1];
        const handlerOf = node => {
          if (!node) return {};
          if (node.type === 'array_creation_expression') { const m = node.text.match(/(\w+)::class\s*,\s*['"](\w+)['"]/); return m ? { controller: m[1], action: m[2] } : {}; }
          if (node.type === 'string') { const s = unquote(node.text); const m = s.match(/(\w+)@(\w+)/); return m ? { controller: m[1], action: m[2] } : /^[\w\\]+$/.test(s) ? { controller: s.split('\\').pop() } : {}; }
          if (node.type === 'class_constant_access_expression') return { controller: node.text.replace(/::class$/, '') };
          return { closure: node };
        };
        const routes = [];
        if (isResource) {
          const resource = routeArg.replace(/^\/+/, '');
          // `articles.comments` (dot nesting) and `articles/{article}/comments` (a path) both name the last segment.
          const segs = resource.split('.');
          const base = segs.map((s, i) => (i < segs.length - 1 ? `${s}/{${singular(s)}}` : s)).join('/');
          const last = segs[segs.length - 1].split('/').filter(Boolean).pop();
          const param = `{${singular(last.replace(/-/g, '_'))}}`;
          // ->only([...]) / ->except([...]) on the chain, or ['only' => [...]] as the third argument.
          const optionsText = `${chain.text.slice(call.text.length)} ${args[2] ? args[2].text : ''}`;
          const only = (optionsText.match(/->only\(\s*\[([^\]]*)\]|['"]only['"]\s*=>\s*\[([^\]]*)\]/) || []).slice(1).find(Boolean);
          const except = (optionsText.match(/->except\(\s*\[([^\]]*)\]|['"]except['"]\s*=>\s*\[([^\]]*)\]/) || []).slice(1).find(Boolean);
          const list = s => (s ? (s.match(/['"](\w+)['"]/g) || []).map(unquote) : undefined);
          const { controller } = handlerOf(handlerArg);
          for (const [action, verb, item] of RESOURCE_ACTIONS) {
            if (list(only) && !list(only).includes(action)) continue;
            if (list(except) && list(except).includes(action)) continue;
            routes.push({ verb, path: item ? `${base}/${param}` : base, controller, action });
          }
        } else {
          for (const verb of matchVerbs ?? (method === 'any' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [VERBS[method]])) routes.push({ verb, path: routeArg, ...handlerOf(handlerArg) });
        }
        for (const r of routes) {
          const p = normalise(sdk, joinPath(filePrefix, ...prefixes, r.path));
          const key = `${r.verb} ${p}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const location = { file: f.rel, startLine: call.startPosition.row + 1, endLine: call.endPosition.row + 1 };
          const endpoint = sdk.makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location, symbol: r.controller ? `${r.controller}.${r.action || ''}` : undefined, description: key, metadata: { method: r.verb, path: p, handler: r.action && !/^(index|store|show|update|destroy|__invoke)$/.test(r.action) ? r.action : undefined, owner: r.controller }, key });
          out.push(endpoint);
          for (const mw of [...new Set(middleware)]) {
            if (/^auth(:|$)/.test(mw)) out.push(sdk.makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location, description: `requires ${mw}`, metadata: { middleware: mw, status: 401 }, key: `auth|${mw}` }));
            const role = mw.match(/^(?:role|can|ability):([\w-]+)/);
            if (role) out.push(sdk.makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location, description: `requires role ${role[1]}`, metadata: { roles: [role[1]], status: 403 }, key: `role|${role[1]}` }));
          }
          const ctrl = r.controller && controllers.get(r.controller);
          const action = ctrl && ctrl.methods.get(r.action || '__invoke');
          if (ctrl && action) {
            const body = bodyEvidence(sdk, ctrl.file, ctrl.text, action, endpoint);
            out.push(...body);
            const reqType = (action.params.match(/(\w+Request)\s+\$\w+/) || [])[1];
            const req = reqType && requests.get(reqType);
            if (req) {
              for (const fld of req.fields) for (const rule of fld.rules) out.push(sdk.makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: req.file, startLine: fld.line, endLine: fld.line }, symbol: `${reqType}.${fld.name}`, description: `${fld.name} ${rule.rule}`, metadata: { field: fld.name.replace(/\.\*$/, ''), rule: rule.rule, param: rule.param, status: 422, dto: reqType }, key: `${fld.name}|${rule.rule}` }));
              out.push(sdk.makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: req.file, startLine: req.line, endLine: req.line }, symbol: reqType, description: `body ${reqType}`, metadata: { dto: reqType, fields: req.fields.map(x => ({ name: x.name, rules: x.rules.map(y => y.rule) })) }, key: reqType }));
            }
            if (!body.some(e => e.kind === 'success-response')) out.push(sdk.makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location, description: `responds ${r.verb === 'POST' ? 201 : r.verb === 'DELETE' ? 204 : 200}`, metadata: { status: r.verb === 'POST' ? 201 : r.verb === 'DELETE' ? 204 : 200 }, key: 'default-status' }));
          } else {
            out.push(sdk.makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location, description: 'responds 200', metadata: { status: 200 }, key: 'default-status' }));
          }
        }
      }
    }
    return out;
  }
};

module.exports = {
  name: '@gherkin-ai/reverse-laravel',
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^3.3' },
  reverseAnalyzers: () => [laravel]
};
