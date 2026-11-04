'use strict';
/* ==========================================================================
   @gherkin-ai/reverse-rails: Ruby on Rails for `ghk reverse` (plugin API 2,
   beta: F1 0.95 on the Rails RealWorld app). Official plugin, kept out of the CLI package so its Ruby
   grammar does not weigh on everyone.

   - Routes (tree-sitter-ruby, config/routes.rb): `resources` / `resource`
     with `only:`, `except:`, `path:`, `param:`, nested resources,
     `member do … end` and `collection do … end`; `namespace`, `scope`;
     `get/post/put/patch/delete 'path', to: 'controller#action'`.
   - Controllers: the action methods; `before_action :authenticate_user!`
     (and `:authenticate*`, `:require_login`) as authentication, with its
     `only:`/`except:`; `params.require(:order).permit(…)` as the input.
   - Bodies (patterns): `render json: …, status: :not_found` and
     `head :conflict` behind `if`/`unless` (block or modifier form), `raise
     ActiveRecord::RecordNotFound`; states (`update!(status: 'paid')`,
     `.status = 'PAID'`); events (`ActiveSupport::Notifications.instrument`,
     `broadcast(:order_paid)`, `publish(…)`); success statuses.
   - Models: `validates :email, presence: true, format: …, length: …` on the
     model the controller permits params of.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ID = 'rails/routes';
const VERBS = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE' };
const PLURAL_ACTIONS = [['index', 'GET', false], ['create', 'POST', false], ['show', 'GET', true], ['update', 'PATCH', true], ['update', 'PUT', true], ['destroy', 'DELETE', true]];
const SINGULAR_ACTIONS = [['show', 'GET'], ['create', 'POST'], ['update', 'PATCH'], ['update', 'PUT'], ['destroy', 'DELETE']];
const STATUS = { ok: 200, created: 201, accepted: 202, no_content: 204, bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, gone: 410, unprocessable_entity: 422, unprocessable_content: 422, too_many_requests: 429 };
const EXCEPTION = { 'ActiveRecord::RecordNotFound': 404, 'ActionController::ParameterMissing': 400, 'ActiveRecord::RecordInvalid': 422, 'Pundit::NotAuthorizedError': 403, 'CanCan::AccessDenied': 403 };

const sym = t => t.replace(/^:/, '').replace(/^['"]|['"]$/g, '');
const singular = w => (/ies$/.test(w) ? w.slice(0, -3) + 'y' : /(ss|us)$/.test(w) ? w : /(sses|xes|ches|shes)$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, ''));
const camel = s => s.split(/[_/]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const statusOf = s => (/^\d{3}$/.test(s) ? Number(s) : STATUS[sym(s)]);

function callName(node) {
  const id = node.namedChildren.find(n => n && (n.type === 'identifier' || n.type === 'constant'));
  return id ? id.text : undefined;
}
const argsOf = node => (node.namedChildren.find(n => n && n.type === 'argument_list') || { namedChildren: [] }).namedChildren.filter(Boolean);
const blockOf = node => node.namedChildren.find(n => n && (n.type === 'do_block' || n.type === 'block'));
function optionsOf(node) {
  const o = {};
  for (const a of argsOf(node)) {
    if (a.type !== 'pair') continue;
    const k = a.namedChildren[0] ? a.namedChildren[0].text.replace(/:$/, '').replace(/^:/, '') : '';
    const v = a.namedChildren[1];
    o[k] = v && v.type === 'array' ? v.namedChildren.filter(Boolean).map(x => sym(x.text)) : v ? sym(v.text) : undefined;
  }
  return o;
}
const firstArg = node => { const a = argsOf(node).find(x => x.type !== 'pair'); return a ? sym(a.text) : undefined; };

/** Walks config/routes.rb and returns every route with its controller and action. */
function routesOf(sdk, root) {
  const routes = [];
  const visit = (node, ctx) => {
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type !== 'call') { if (child.type === 'body_statement' || child.type === 'do_block' || child.type === 'block') visit(child, ctx); continue; }
      const name = callName(child);
      const block = blockOf(child);
      const opts = optionsOf(child);
      const arg = firstArg(child);
      const where = { startLine: child.startPosition.row + 1, endLine: child.endPosition.row + 1 };
      if (name === 'namespace' && arg) { if (block) visit(block, { ...ctx, prefix: [...ctx.prefix, opts.path || arg], module: [...ctx.module, arg] }); continue; }
      if (name === 'scope') { const p = arg || opts.path; if (block) visit(block, { ...ctx, prefix: p ? [...ctx.prefix, p.replace(/^\//, '')] : ctx.prefix, module: opts.module ? [...ctx.module, opts.module] : ctx.module }); continue; }
      if ((name === 'resources' || name === 'resource') && arg) {
        const plural = name === 'resources';
        const seg = opts.path || arg;
        const param = `:${opts.param || 'id'}`;
        const controller = [...ctx.module, opts.controller || (plural ? arg : `${arg}s`)].join('/');
        const only = opts.only ? [].concat(opts.only) : undefined;
        const except = opts.except ? [].concat(opts.except) : [];
        const base = [...ctx.prefix, ...ctx.parent, seg];
        const actions = plural ? PLURAL_ACTIONS : SINGULAR_ACTIONS.map(([a, v]) => [a, v, false]);
        for (const [action, verb, item] of actions) {
          if (only && !only.includes(action)) continue;
          if (except.includes(action)) continue;
          routes.push({ verb, path: [...base, ...(item ? [param] : [])].join('/'), controller, action, where });
        }
        if (block) visit(block, { ...ctx, resource: { base, param, controller, plural }, parent: [...ctx.parent, seg, ...(plural ? [`:${singular(arg)}_id`] : [])] });
        continue;
      }
      if ((name === 'member' || name === 'collection') && block && ctx.resource) { visit(block, { ...ctx, scope: name }); continue; }
      // Devise: `devise_for :users` serves sign-in (sessions#create) and sign-up (registrations#create) for the API,
      // `path_names: { sign_in: :login }` renaming the sign-in path.
      if (name === 'devise_for' && arg) {
        const signIn = (child.text.match(/sign_in:\s*[:'"]?(\w+)/) || [])[1] || 'sign_in';
        const sessions = (child.text.match(/sessions:\s*[:'"]?([\w/]+)/) || [])[1] || 'devise/sessions';
        const registrations = (child.text.match(/registrations:\s*[:'"]?([\w/]+)/) || [])[1] || 'devise/registrations';
        const skip = (child.text.match(/skip:\s*\[([^\]]*)\]/) || [])[1] || '';
        if (!/sessions/.test(skip)) routes.push({ verb: 'POST', path: [...ctx.prefix, arg, signIn].join('/'), controller: sessions, action: 'create', where });
        if (!/registrations/.test(skip)) routes.push({ verb: 'POST', path: [...ctx.prefix, arg].join('/'), controller: registrations, action: 'create', where });
        continue;
      }
      if (VERBS[name]) {
        let p = arg || '';
        let controller, action;
        if (opts.to) [controller, action] = opts.to.split('#');
        // `get :feed, on: :collection` inside a resource is the block form in one line.
        const scope = ctx.scope || (opts.on && ctx.resource ? opts.on : undefined);
        if (scope && ctx.resource) {
          action = action || p;
          controller = controller ? [...ctx.module, controller].join('/') : ctx.resource.controller;
          routes.push({ verb: VERBS[name], path: [...ctx.resource.base, ...(scope === 'member' ? [ctx.resource.param] : []), p].join('/'), controller, action, where });
        } else {
          if (!controller && /#/.test(p)) [controller, action] = p.split('#');
          routes.push({ verb: VERBS[name], path: [...ctx.prefix, ...ctx.parent, p.replace(/^\//, '')].join('/'), controller: controller ? [...ctx.module, controller].join('/') : undefined, action, where });
        }
        continue;
      }
      if (block) visit(block, ctx);
    }
  };
  visit(root, { prefix: [], module: [], parent: [], resource: undefined, scope: undefined });
  return routes.map(r => ({ ...r, path: sdk.normalisePath(`/${r.path}`.replace(/\/+/g, '/')) }));
}

/** Controllers by path (`api/orders`), with their actions, before_actions and permitted params. */
function controllersOf(files) {
  const out = new Map();
  for (const f of files) {
    const m = f.rel.match(/(?:^|\/)app\/controllers\/(.+)_controller\.rb$/);
    if (!m) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const actions = new Map();
    lines.forEach((line, i) => {
      const d = line.match(/^(\s*)def\s+(\w+[!?]?)/);
      if (!d) return;
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^${d[1]}end\\b`).test(lines[j])) j++;
      actions.set(d[2], { line: i + 1, endLine: j + 1, body: lines.slice(i + 1, j).join('\n'), startLine: i + 2 });
    });
    const auth = [...text.matchAll(/before_action\s+:(authenticate\w*!?|require_login|authorize_request|authenticate_user!)(?:\s*,\s*(only|except):\s*(\[[^\]]*\]|:\w+))?/g)].map(x => ({ line: text.slice(0, x.index).split('\n').length, mode: x[2], actions: x[3] ? (x[3].match(/:\w+/g) || []).map(sym) : undefined }));
    const permits = [...text.matchAll(/params\.require\(\s*:(\w+)\s*\)\.permit\(([^)]*)\)/g)].map(x => ({ model: x[1], fields: (x[2].match(/:(\w+)/g) || []).map(sym), line: text.slice(0, x.index).split('\n').length }));
    out.set(m[1], { file: f.rel, actions, auth, permits });
  }
  return out;
}

function modelValidations(files) {
  const out = new Map();
  for (const f of files) {
    const m = f.rel.match(/(?:^|\/)app\/models\/(\w+)\.rb$/);
    if (!m) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const rules = [];
    for (const v of text.matchAll(/^\s*validates?\s+([:\w, ]+?),\s*(.+)$/gm)) {
      const fields = (v[1].match(/:(\w+)/g) || []).map(sym);
      const line = text.slice(0, v.index).split('\n').length;
      const opts = v[2];
      const found = [];
      if (/presence:\s*true/.test(opts)) found.push(['required']);
      if (/format:\s*\{[^}]*EMAIL|URI::MailTo::EMAIL_REGEXP|email/i.test(opts)) found.push(['email']);
      else if (/format:/.test(opts)) found.push(['pattern']);
      const len = opts.match(/length:\s*\{([^}]*)\}/);
      if (len) { const max = len[1].match(/maximum:\s*(\d+)/); const min = len[1].match(/minimum:\s*(\d+)/); if (max) found.push(['maxLength', max[1]]); if (min) found.push(['minLength', min[1]]); }
      if (/uniqueness:/.test(opts)) found.push(['unique']);
      if (/numericality:/.test(opts)) found.push(['min']);
      for (const field of fields) for (const [rule, param] of found) rules.push({ field, rule, param, line });
    }
    out.set(m[1], { file: f.rel, rules });
  }
  return out;
}

function bodyEvidence(sdk, file, action, endpointId) {
  const out = [];
  const lines = action.body.split('\n');
  const ev = (kind, idx, description, metadata, key) => out.push(sdk.makeEvidence({ kind, extractor: ID, confidence: 'strong', references: [endpointId], location: { file, startLine: action.startLine + idx, endLine: action.startLine + idx }, description, metadata, key }));
  const failure = (idx, status, condition, message, key) => ev(status === 401 || status === 403 ? 'authorization-rule' : 'error-condition', idx, `${message || `status ${status}`}${condition ? ` when ${condition}` : ''}`, { status, message, condition, technical: status >= 500 }, key);
  lines.forEach((line, i) => {
    // Modifier form: `render json: { error: '…' }, status: :conflict and return if cond` / `return head :forbidden unless cond`.
    const mod = line.match(/(?:render\s+json:\s*(.*?),\s*status:\s*(:?\w+)|head\s+(:?\w+)).*?\b(if|unless)\s+(.+)$/);
    if (mod) {
      const status = statusOf(mod[2] || mod[3]);
      if (status >= 400) failure(i, status, `${mod[4] === 'unless' ? 'not ' : ''}${mod[5].trim()}`, (mod[1] || '').match(/['"]([^'"]{4,})['"]/)?.[1], `mod|${i}|${status}`);
      return;
    }
    // Block form: `if cond` … `render json: …, status: :not_found` / `head :conflict` / `raise …`.
    const open = line.match(/^\s*(if|unless)\s+(.+)$/);
    if (open) {
      const next = lines.slice(i + 1, i + 4).join('\n');
      const r = next.match(/render\s+json:\s*(.*?),\s*status:\s*(:?\w+)|head\s+(:?\w+)|raise\s+([\w:]+)(?:,?\s*\(?['"]([^'"]+)['"])?/);
      if (r) {
        const status = r[4] ? EXCEPTION[r[4]] || (/NotFound/.test(r[4]) ? 404 : undefined) : statusOf(r[2] || r[3]);
        if (status >= 400) failure(i, status, `${open[1] === 'unless' ? 'not ' : ''}${open[2].trim()}`, r[5] || (r[1] || '').match(/['"]([^'"]{4,})['"]/)?.[1], `if|${i}|${status}`);
      }
    }
    for (const s of line.matchAll(/\.status\s*=\s*['"]([A-Za-z][\w-]*)['"]|status:\s*['"]([A-Za-z][\w-]*)['"]/g)) ev('state-value', i, `status set to ${s[1] || s[2]}`, { field: 'status', value: s[1] || s[2], initial: !s[1] && /\.(create|new)\b/.test(line) }, `state|${i}|${s[1] || s[2]}`);
    for (const e of line.matchAll(/Notifications\.instrument\(\s*['"]([\w.]+)['"]|broadcast\(\s*:(\w+)|publish\(\s*[:'"]([\w.]+)/g)) {
      const raw = e[1] || e[2] || e[3];
      const name = raw.split(/[._]/).map(w => w[0].toUpperCase() + w.slice(1)).join('');
      ev('domain-event', i, `publishes ${name}`, { event: name, channel: raw }, `event|${i}|${raw}`);
    }
    const ok = line.match(/render\s+json:.*status:\s*(:?\w+)|head\s+(:no_content|:created|:ok|:accepted)/);
    if (ok && !/\b(if|unless)\b/.test(line)) { const st = statusOf(ok[1] || ok[2]); if (st && st < 400) ev('success-response', i, `responds ${st}`, { status: st }, `ok|${i}`); }
  });
  return out;
}

const rails = {
  id: ID,
  language: 'ruby',
  frameworks: ['rails'],
  maturity: 'beta',
  detect: ctx => ctx.files.some(f => /(^|\/)config\/routes\.rb$/.test(f.rel)),
  analyze: async ctx => {
    const sdk = ctx.sdk;
    const parser = await sdk.loadGrammar(path.join(__dirname, 'grammar', 'tree-sitter-ruby.wasm'));
    const controllers = controllersOf(ctx.files);
    const models = modelValidations(ctx.files);
    const out = [];
    const seen = new Set();
    for (const f of ctx.files.filter(x => /(^|\/)config\/routes\.rb$/.test(x.rel))) {
      let text;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const tree = parser.parse(text);
      if (!tree) continue;
      for (const r of routesOf(sdk, tree.rootNode)) {
        const key = `${r.verb} ${r.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const owner = r.controller ? `${camel(r.controller)}Controller` : undefined;
        const endpoint = sdk.makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: { file: f.rel, ...r.where }, symbol: owner && r.action ? `${owner}#${r.action}` : undefined, description: key, metadata: { method: r.verb, path: r.path, handler: r.action && !/^(index|create|show|update|destroy)$/.test(r.action) ? r.action : undefined, owner }, key });
        out.push(endpoint);
        const ctrl = r.controller && controllers.get(r.controller);
        const action = ctrl && r.action && ctrl.actions.get(r.action);
        if (ctrl) {
          for (const a of ctrl.auth) {
            const applies = !a.actions || (a.mode === 'only' ? a.actions.includes(r.action) : !a.actions.includes(r.action));
            if (applies) out.push(sdk.makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: ctrl.file, startLine: a.line, endLine: a.line }, description: 'requires an authenticated user', metadata: { status: 401 }, key: `auth|${a.line}` }));
          }
          if (r.verb !== 'GET' && r.verb !== 'DELETE') {
            for (const p of ctrl.permits) {
              out.push(sdk.makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: ctrl.file, startLine: p.line, endLine: p.line }, symbol: p.model, description: `params ${p.model} (${p.fields.join(', ')})`, metadata: { dto: p.model, fields: p.fields.map(n => ({ name: n, rules: (models.get(p.model)?.rules ?? []).filter(x => x.field === n).map(x => x.rule) })) }, key: `permit|${p.model}` }));
              const model = models.get(p.model);
              for (const v of model ? model.rules.filter(x => p.fields.includes(x.field)) : []) out.push(sdk.makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: model.file, startLine: v.line, endLine: v.line }, symbol: `${camel(p.model)}.${v.field}`, description: `${v.field} ${v.rule}`, metadata: { field: v.field, rule: v.rule, param: v.param, status: 422, dto: camel(p.model) }, key: `${v.field}|${v.rule}` }));
            }
          }
        }
        const body = action ? bodyEvidence(sdk, ctrl.file, action, endpoint.id) : [];
        out.push(...body);
        if (!body.some(e => e.kind === 'success-response')) out.push(sdk.makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location: endpoint.location, description: `responds ${r.verb === 'DELETE' ? 204 : 200}`, metadata: { status: r.verb === 'DELETE' ? 204 : 200 }, key: 'default-status' }));
      }
    }
    return out;
  }
};

module.exports = {
  name: '@gherkin-ai/reverse-rails',
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^3.3' },
  reverseAnalyzers: () => [rails]
};
