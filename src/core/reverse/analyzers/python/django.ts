/* ==========================================================================
   gherkin-ai-cli - Django and Django REST framework adapter for `ghk reverse`
   (PLAN-3.3.0-reverse-plus RV-12). Python through tree-sitter.

   - Routes: urls.py `path('orders/<int:pk>/', …)`, `re_path(r'^…$', …)` and
     `url(r'^…$', …)`, with the prefix of every `include('app.urls')` that
     reaches them; DRF routers (`router.register(r'articles', ArticleViewSet)`
     with `include(router.urls)`).
   - Views: ViewSets (ModelViewSet, ReadOnlyModelViewSet, GenericViewSet and
     its mixins, the actions a class defines, `@action(detail=…,
     methods=[…])`, `lookup_field`); generic views (ListCreateAPIView,
     RetrieveUpdateAPIView, …); APIView `get/post/put/patch/delete`;
     `@api_view(['POST'])` functions.
   - Security: `permission_classes` (IsAuthenticated 401, IsAdminUser 403,
     IsAuthenticatedOrReadOnly on writes).
   - Input: `serializer_class` fields and their rules (EmailField, required,
     max_length/min_length, min_value/max_value).
   - Bodies: the same analysis as FastAPI (raise NotFound / ValidationError,
     `Response(status=status.HTTP_…)`, states, events, integrations, calls).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { isTestFile } from '../../discovery';
import { joinPaths, makeEvidence, normalisePath, type EndpointMetadata, type SourceEvidence } from '../../evidence';
import type { AnalysisContext, SourceAnalyzer } from '../../registry';
import { childOfType, childrenOfType, lineRange, ofType, parserFor, unquote, type TSNode } from '../treesitter/loader';
import { analyzeBody, pythonStatus, type PyFunction } from './fastapi';

const ID = 'python/django';
type Verb = EndpointMetadata['method'];

/** `^articles/(?P<slug>[-\w]+)/favorite/?$` → /articles/{slug}/favorite; undefined for patterns that are not plain paths. */
export function djangoRegexPath(regex: string): string | undefined {
  let p = regex.replace(/^\^/, '').replace(/\$$/, '').replace(/\/\?$/, '').replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}').replace(/\\\./g, '.');
  if (/[()[\]*+?|\\]/.test(p)) return undefined;
  if (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** A route string of path() or re_path()/url(): to a normalised path fragment, or undefined. */
function routeOf(fn: string, raw: string): string | undefined {
  if (fn === 'path') return raw.replace(/\/$/, '');
  return djangoRegexPath(raw);
}

const GENERIC_VERBS: Record<string, Verb[]> = {
  ListAPIView: ['GET'], CreateAPIView: ['POST'], ListCreateAPIView: ['GET', 'POST'], RetrieveAPIView: ['GET'], UpdateAPIView: ['PUT', 'PATCH'],
  DestroyAPIView: ['DELETE'], RetrieveUpdateAPIView: ['GET', 'PUT', 'PATCH'], RetrieveDestroyAPIView: ['GET', 'DELETE'], RetrieveUpdateDestroyAPIView: ['GET', 'PUT', 'PATCH', 'DELETE']
};
/** ViewSet actions: name → verb and whether it acts on one item. */
const ACTIONS: Record<string, { verb: Verb; detail: boolean; mixin: string }> = {
  list: { verb: 'GET', detail: false, mixin: 'ListModelMixin' }, create: { verb: 'POST', detail: false, mixin: 'CreateModelMixin' },
  retrieve: { verb: 'GET', detail: true, mixin: 'RetrieveModelMixin' }, update: { verb: 'PUT', detail: true, mixin: 'UpdateModelMixin' },
  partial_update: { verb: 'PATCH', detail: true, mixin: 'UpdateModelMixin' }, destroy: { verb: 'DELETE', detail: true, mixin: 'DestroyModelMixin' }
};
/** The method of a view class that handles a verb: APIView names (get, post…) or the generic action names. */
const HANDLER_OF: Record<Verb, string[]> = { GET: ['get', 'retrieve', 'list'], POST: ['post', 'create'], PUT: ['put', 'update'], PATCH: ['patch', 'partial_update'], DELETE: ['delete', 'destroy'] };
const DEFAULT_STATUS: Record<Verb, number> = { GET: 200, POST: 201, PUT: 200, PATCH: 200, DELETE: 204 };
const FIELD_RULES: Record<string, string> = { max_length: 'maxLength', min_length: 'minLength', min_value: 'min', max_value: 'max' };

interface PyClass { name: string; bases: string[]; file: string; module: string; node: TSNode; methods: PyFunction[]; attrs: Map<string, TSNode> }
interface Route { method: Verb; path: string; view: PyClass | PyFunction; handler?: PyFunction; isClass: boolean }

const moduleOf = (rel: string) => rel.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');

const django: SourceAnalyzer = {
  id: ID,
  language: 'python',
  frameworks: ['django', 'django-rest-framework'],
  maturity: 'beta',
  detect(ctx) {
    return ctx.files.some(f => /(^|\/)urls\.py$/.test(f.rel) && !isTestFile(f.rel) && (() => {
      try { return /\b(path|re_path|url)\s*\(|\.register\s*\(/.test(fs.readFileSync(f.abs, 'utf8')); } catch { return false; }
    })());
  },
  async analyze(ctx: AnalysisContext) {
    const parser = await parserFor('python');
    const functions: PyFunction[] = [];
    const classes: PyClass[] = [];
    const urlFiles: { rel: string; module: string; root: TSNode }[] = [];
    for (const f of ctx.files.filter(x => x.ext === '.py' && !isTestFile(x.rel) && !/(^|\/)(migrations|venv|\.venv)\//.test(x.rel))) {
      let tree;
      try { tree = parser.parse(fs.readFileSync(f.abs, 'utf8')); } catch { continue; }
      if (!tree) continue;
      const module = path.posix.basename(f.rel, '.py');
      for (const def of ofType(tree.rootNode, 'function_definition')) {
        const decorated = def.parent?.type === 'decorated_definition' ? def.parent : undefined;
        functions.push({ name: def.childForFieldName('name')?.text ?? '', module, file: f.rel, node: def, body: def.childForFieldName('body') ?? undefined, decorators: childrenOfType(decorated, 'decorator'), params: def.childForFieldName('parameters') });
      }
      for (const cls of ofType(tree.rootNode, 'class_definition')) {
        const body = cls.childForFieldName('body');
        // A method is a function whose block (through its decorators) is the class body. web-tree-sitter nodes are
        // not unique objects, so blocks are compared by position.
        const sameNode = (a: TSNode | null | undefined, b: TSNode | null | undefined) => Boolean(a && b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type);
        const methods = functions.filter(fn => fn.file === f.rel && sameNode(fn.node.parent?.type === 'decorated_definition' ? fn.node.parent.parent : fn.node.parent, body));
        const attrs = new Map<string, TSNode>();
        for (const a of childrenOfType(body, 'expression_statement').map(s => s.namedChildren[0]).filter((x): x is TSNode => x?.type === 'assignment')) attrs.set(a.childForFieldName('left')?.text ?? '', a.childForFieldName('right')!);
        classes.push({ name: cls.childForFieldName('name')?.text ?? '', bases: (cls.childForFieldName('superclasses')?.text ?? '').replace(/[()\s]/g, '').split(',').filter(Boolean).map(b => b.split('.').pop()!), file: f.rel, module, node: cls, methods, attrs });
      }
      if (/(^|\/)urls\.py$/.test(f.rel)) urlFiles.push({ rel: f.rel, module: moduleOf(f.rel), root: tree.rootNode });
    }
    const classByName = (n: string) => classes.find(c => c.name === n);
    const methodsOf = (c: PyClass): PyFunction[] => [...c.methods, ...c.bases.map(classByName).filter((b): b is PyClass => Boolean(b)).flatMap(methodsOf)];

    // urls.py entries, and the prefixes include() gives each urls module.
    type Entry = { fn: string; route: string; target: TSNode; node: TSNode };
    const entries = new Map<string, Entry[]>();
    const routers = new Map<string, { prefix: string; viewset: string; node: TSNode }[]>(); // module → registrations
    for (const u of urlFiles) {
      const list: Entry[] = [];
      for (const call of ofType(u.root, 'call')) {
        const fn = call.childForFieldName('function')?.text ?? '';
        const args = call.childForFieldName('arguments')?.namedChildren.filter((a): a is TSNode => Boolean(a)) ?? [];
        if (/^(path|re_path|url)$/.test(fn) && args[0]?.type === 'string' && args[1]) list.push({ fn, route: unquote(args[0].text) ?? '', target: args[1], node: call });
        if (/\.register$/.test(fn) && args[0]?.type === 'string' && args[1]) routers.set(u.module, [...(routers.get(u.module) ?? []), { prefix: (unquote(args[0].text) ?? '').replace(/^\^|\$$/g, ''), viewset: args[1].text.split('.').pop()!, node: call }]);
      }
      entries.set(u.module, list);
    }
    const modules = new Set(urlFiles.map(u => u.module));
    const included = new Set<string>();
    for (const list of entries.values()) for (const e of list) {
      const m = e.target.text.match(/^include\(\s*['"]([\w.]+)['"]/);
      if (m) included.add([...modules].find(x => x === m[1] || x.endsWith(`.${m[1]}`) || m[1].endsWith(x)) ?? m[1]);
    }
    const resolveModule = (name: string) => [...modules].find(x => x === name || x.endsWith(`.${name}`) || name.endsWith(x));

    const routes: Route[] = [];
    const visit = (module: string, prefix: string, depth: number) => {
      if (depth > 6) return;
      for (const e of entries.get(module) ?? []) {
        const frag = routeOf(e.fn, e.route);
        if (frag === undefined) continue;
        const here = joinPaths(prefix, frag);
        const inc = e.target.text.match(/^include\(\s*['"]([\w.]+)['"]/);
        if (inc) { const m = resolveModule(inc[1]); if (m) visit(m, here, depth + 1); continue; }
        if (/^include\(\s*\w+\.urls\s*\)/.test(e.target.text)) { for (const r of routers.get(module) ?? []) addViewSet(r, here); continue; }
        const viewName = e.target.text.replace(/\.as_view\([\s\S]*\)$/, '').split('.').pop()!;
        const cls = classByName(viewName);
        if (cls) { addClassView(cls, here); continue; }
        const fn = functions.find(f => f.name === viewName);
        if (fn) addFunctionView(fn, here);
      }
      // A router whose urls are not included anywhere in this module (urlpatterns = router.urls) is still served here.
      if (!(entries.get(module) ?? []).some(e => /^include\(\s*\w+\.urls\s*\)/.test(e.target.text)) && /router\.urls/.test(urlFiles.find(u => u.module === module)?.root.text ?? '')) {
        for (const r of routers.get(module) ?? []) addViewSet(r, prefix);
      }
    };
    const addClassView = (cls: PyClass, p: string) => {
      const methods = methodsOf(cls);
      const generic = cls.bases.flatMap(b => GENERIC_VERBS[b] ?? []);
      const verbs = new Set<Verb>(generic);
      for (const v of Object.keys(HANDLER_OF) as Verb[]) if (methods.some(m => m.name === v.toLowerCase())) verbs.add(v);
      for (const verb of verbs) routes.push({ method: verb, path: p, view: cls, isClass: true, handler: HANDLER_OF[verb].map(n => methods.find(m => m.name === n)).find(Boolean) });
    };
    const addFunctionView = (fn: PyFunction, p: string) => {
      const dec = fn.decorators.map(d => d.text).find(t => /^@api_view\b|^@require_(http_methods|POST|GET)\b/.test(t));
      if (!dec) return;
      const verbs = /require_POST/.test(dec) ? ['POST'] : /require_GET/.test(dec) ? ['GET'] : [...dec.matchAll(/['"](GET|POST|PUT|PATCH|DELETE)['"]/gi)].map(m => m[1].toUpperCase());
      for (const verb of (verbs.length ? verbs : ['GET']) as Verb[]) routes.push({ method: verb, path: p, view: fn, isClass: false, handler: fn });
    };
    const addViewSet = (r: { prefix: string; viewset: string }, base: string) => {
      const cls = classByName(r.viewset);
      if (!cls) return;
      const methods = methodsOf(cls);
      const all = cls.bases.some(b => /^ModelViewSet$/.test(b));
      const readOnly = cls.bases.some(b => /^ReadOnlyModelViewSet$/.test(b));
      const lookup = unquote(cls.attrs.get('lookup_field')?.text ?? '') ?? 'pk';
      const collection = joinPaths(base, r.prefix.replace(/\/$/, ''));
      for (const [action, a] of Object.entries(ACTIONS)) {
        const declared = methods.some(m => m.name === action);
        const fromBase = all || (readOnly && (action === 'list' || action === 'retrieve')) || cls.bases.includes(a.mixin);
        if (!declared && !fromBase) continue;
        routes.push({ method: a.verb, path: a.detail ? `${collection}/{${lookup}}` : collection, view: cls, isClass: true, handler: methods.find(m => m.name === action) });
      }
      for (const m of methods) {
        const act = m.decorators.map(d => d.text).find(t => /^@action\b/.test(t));
        if (!act) continue;
        const detail = /detail\s*=\s*True/.test(act);
        const sub = act.match(/url_path\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? m.name.replace(/_/g, '-');
        const verbs = [...act.matchAll(/['"](get|post|put|patch|delete)['"]/gi)].map(x => x[1].toUpperCase() as Verb);
        for (const verb of verbs.length ? verbs : ['GET' as Verb]) routes.push({ method: verb, path: joinPaths(detail ? `${collection}/{${lookup}}` : collection, sub), view: cls, isClass: true, handler: m });
      }
    };
    const roots = [...modules].filter(m => !included.has(m));
    for (const m of roots.length ? roots : [...modules]) visit(m, '', 0);

    const out: SourceEvidence[] = [];
    const seen = new Set<string>();
    for (const r of routes) {
      const p = normalisePath(r.path || '/');
      const key = `${r.method} ${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const owner = r.isClass ? (r.view as PyClass) : undefined;
      const node = r.handler?.node ?? r.view.node;
      const endpoint = makeEvidence({
        kind: 'http-endpoint', extractor: ID, confidence: 'strong', location: { file: r.view.file, ...lineRange(node) },
        symbol: `${r.view.name}${r.handler ? `.${r.handler.name}` : ''}`, description: key, key,
        metadata: { method: r.method, path: p, handler: r.handler && !/^(get|post|put|patch|delete|list|create|retrieve|update|partial_update|destroy)$/.test(r.handler.name) ? r.handler.name : undefined, owner: r.view.name } satisfies EndpointMetadata
      });
      out.push(endpoint);
      // Permissions: authentication (401), staff (403), authentication on writes only.
      const perms = owner?.attrs.get('permission_classes')?.text ?? (!r.isClass ? (r.view as PyFunction).decorators.map(d => d.text).find(t => /permission_classes/.test(t)) : undefined) ?? '';
      const needsAuth = /\bIsAuthenticated\b(?!OrReadOnly)/.test(perms) || (/IsAuthenticatedOrReadOnly/.test(perms) && r.method !== 'GET');
      if (needsAuth) out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: r.view.file, ...lineRange(owner?.attrs.get('permission_classes') ?? node) }, description: 'requires an authenticated user', metadata: { status: 401 } }));
      if (/IsAdminUser/.test(perms)) out.push(makeEvidence({ kind: 'authorization-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: r.view.file, ...lineRange(owner?.attrs.get('permission_classes') ?? node) }, description: 'requires role admin', metadata: { roles: ['admin'], status: 403 } }));
      // The serializer's fields and rules, on writes.
      const serializer = owner ? classByName((owner.attrs.get('serializer_class')?.text ?? '').split('.').pop() ?? '') : undefined;
      // A custom @action uses the view's serializer only when its body asks for it.
      const usesSerializer = !r.handler || /^(create|update|partial_update|post|put|patch)$/.test(r.handler.name) || /serializer/i.test(r.handler.body?.text ?? '');
      if (serializer && usesSerializer && r.method !== 'GET' && r.method !== 'DELETE') {
        const fields: { name: string; type: string; rules: string[] }[] = [];
        for (const [name, value] of serializer.attrs) {
          if (value.type !== 'call' || !/serializers\.\w+Field|\w+Field$/.test(value.childForFieldName('function')?.text ?? '')) continue;
          const ftype = (value.childForFieldName('function')?.text ?? '').split('.').pop()!;
          if (/read_only\s*=\s*True/.test(value.text)) continue;
          const rules: string[] = [];
          if (!/required\s*=\s*False/.test(value.text) && !/default\s*=/.test(value.text)) rules.push('required');
          if (/^EmailField$/.test(ftype)) rules.push('email');
          for (const k of childrenOfType(childOfType(value, 'argument_list'), 'keyword_argument')) {
            const rule = FIELD_RULES[k.childForFieldName('name')?.text ?? ''];
            if (rule) rules.push(rule);
          }
          for (const rule of rules) out.push(makeEvidence({ kind: 'validation-rule', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: serializer.file, ...lineRange(value) }, symbol: `${serializer.name}.${name}`, description: `${name} ${rule}`, metadata: { field: name, rule, status: 400, dto: serializer.name, param: childrenOfType(childOfType(value, 'argument_list'), 'keyword_argument').find(k => FIELD_RULES[k.childForFieldName('name')?.text ?? ''] === rule)?.childForFieldName('value')?.text } }));
          fields.push({ name, type: ftype, rules });
        }
        if (fields.length) out.push(makeEvidence({ kind: 'input-contract', extractor: ID, confidence: 'strong', references: [endpoint.id], location: { file: serializer.file, ...lineRange(serializer.node) }, symbol: serializer.name, description: `body ${serializer.name} (${fields.map(f => f.name).join(', ')})`, metadata: { dto: serializer.name, fields } }));
      }
      const body = r.handler ? analyzeBody(r.handler, endpoint.id, functions, 0, new Set(), ID) : [];
      out.push(...body);
      if (!body.some(e => e.kind === 'success-response')) {
        const declared = r.handler?.body ? [...r.handler.body.text.matchAll(/return\s+Response\([^)]*\)/g)].map(m => pythonStatus(m[0])).find(s => s !== undefined && s < 400) : undefined;
        out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: declared ? 'strong' : 'inferred', references: [endpoint.id], location: endpoint.location, description: `responds ${declared ?? DEFAULT_STATUS[r.method]}`, metadata: { status: declared ?? DEFAULT_STATUS[r.method] } }));
      }
    }
    return out;
  }
};

export default django;
