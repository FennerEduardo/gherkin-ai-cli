/* ==========================================================================
   gherkin-ai-cli - `ghk graph --serve` (4.9): live traceability graph in the browser

   A read-only HTTP server bound to 127.0.0.1. The graph is rebuilt on every
   request, so edits to features and code show up on reload. Same protections
   as the Web Studio (src/ui/server.ts): exact Host match (DNS rebinding) and a
   per-session token, passed in the URL fragment and sent by the page as the
   X-Ghk-Token header. The page has no external resources.
   ========================================================================== */

import crypto from 'crypto';
import http from 'http';
import { URL } from 'url';
import { buildRepositoryGraph, GraphOptions, RepositoryGraph, traceGraph } from './repository-graph';

export interface GraphServerOptions extends GraphOptions {
  token: string;
}

function send(res: http.ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(body);
}

function tokenMatches(presented: string | string[] | undefined, token: string): boolean {
  return typeof presented === 'string' && presented.length === token.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
}

/** The server, not listening yet. Hosts are checked against the port it ends up listening on. */
export function createGraphServer(projectDir: string, options: GraphServerOptions): http.Server {
  const build = (): RepositoryGraph => buildRepositoryGraph(projectDir, options);
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'Forbidden host\n');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed\n', { Allow: 'GET' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/') {
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(res, 200, 'text/html; charset=utf-8', renderPage(nonce), {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      });
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'text/plain', 'Not found\n');
    if (!tokenMatches(req.headers['x-ghk-token'], options.token)) return send(res, 401, 'application/json', JSON.stringify({ error: 'Missing or invalid session token. Open the URL printed by `ghk graph --serve`.' }));

    try {
      if (url.pathname === '/api/graph') return send(res, 200, 'application/json', JSON.stringify(build()));
      if (url.pathname === '/api/trace') {
        const query = url.searchParams.get('q') ?? '';
        const view = traceGraph(build(), query, Math.min(Math.max(Number(url.searchParams.get('depth') ?? 3) || 3, 1), 6));
        return send(res, 200, 'application/json', JSON.stringify({ query, roots: view.roots.map(r => r.id), nodes: view.nodes, edges: view.edges }));
      }
      return send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      return send(res, 500, 'application/json', JSON.stringify({ error: (err as Error).message }));
    }
  });
  return server;
}

/** Starts the server on 127.0.0.1 and resolves with the URL that carries the session token. */
export function startGraphServer(projectDir: string, port: number, options: GraphOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const token = crypto.randomBytes(24).toString('hex');
  const server = createGraphServer(projectDir, { ...options, token });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${actual}/#token=${token}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

/** Single page: layered SVG (feature → scenario → command / event / endpoint → file → test), search and trace. */
function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Traceability graph</title>
<style nonce="${nonce}">
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #d6d3d1; --panel: #fff; --hl: #2563eb;
    --feature: #7c3aed; --scenario: #0891b2; --command: #16a34a; --event: #ea580c; --endpoint: #ca8a04; --file: #475569; --test: #db2777; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --panel: #292524; } }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); display: grid; grid-template-columns: 1fr 320px; height: 100vh; }
  header { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0; } header input { flex: 1; max-width: 360px; padding: 6px 8px; }
  #stats { color: var(--muted); font-size: 12px; }
  main { overflow: auto; } aside { border-left: 1px solid var(--line); background: var(--panel); padding: 12px 16px; overflow: auto; }
  svg text { font-size: 11px; fill: var(--fg); pointer-events: none; }
  .node rect { fill: var(--panel); stroke-width: 1.5; cursor: pointer; } .node.dim { opacity: .2; } .node.hit rect { stroke-width: 3; }
  .k-feature rect { stroke: var(--feature); } .k-scenario rect { stroke: var(--scenario); } .k-command rect { stroke: var(--command); }
  .k-event rect { stroke: var(--event); } .k-endpoint rect { stroke: var(--endpoint); } .k-file rect { stroke: var(--file); } .k-test rect { stroke: var(--test); }
  .edge { fill: none; stroke: var(--line); } .edge.on { stroke: var(--hl); stroke-width: 1.5; } .edge.dim { opacity: .15; }
  .col { font-size: 12px; font-weight: 600; fill: var(--muted); text-transform: uppercase; }
  aside h2 { font-size: 13px; margin: 12px 0 4px; } aside ul { margin: 0; padding-left: 18px; } aside li { margin: 2px 0; word-break: break-all; }
  button { cursor: pointer; }
</style>
</head>
<body>
<header><h1>Traceability graph</h1><input id="q" placeholder="Search a command, event, endpoint, scenario or file" aria-label="Search"><button id="reload">Reload</button><span id="stats"></span></header>
<main><svg id="g" role="img" aria-label="Traceability graph"></svg></main>
<aside id="detail"><p>Click a node to trace it: what implements it, what tests it and which scenarios use it.</p></aside>
<script nonce="${nonce}">
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  const KINDS = ['feature', 'scenario', 'command', 'event', 'endpoint', 'file', 'test'];
  const COL = 230, ROW = 26, W = 200, H = 20, TOP = 40;
  const svg = document.getElementById('g'), detail = document.getElementById('detail'), q = document.getElementById('q');
  const NS = 'http://www.w3.org/2000/svg';
  let graph = { nodes: [], edges: [] }, pos = new Map(), nodeEls = new Map(), edgeEls = [];
  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
  const api = path => fetch(path, { headers: { 'X-Ghk-Token': token } }).then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error || r.status))));

  function draw() {
    svg.replaceChildren(); pos = new Map(); nodeEls = new Map(); edgeEls = [];
    const columns = KINDS.map(k => graph.nodes.filter(n => n.kind === k).sort((a, b) => a.label.localeCompare(b.label)));
    const rows = Math.max(1, ...columns.map(c => c.length));
    svg.setAttribute('width', KINDS.length * COL + 20); svg.setAttribute('height', TOP + rows * ROW + 20);
    const edges = el('g', {}, svg);
    columns.forEach((nodes, c) => {
      el('text', { x: 10 + c * COL, y: 22, class: 'col' }, svg).textContent = KINDS[c] + 's (' + nodes.length + ')';
      nodes.forEach((n, r) => {
        const x = 10 + c * COL, y = TOP + r * ROW;
        pos.set(n.id, { x, y });
        const g = el('g', { class: 'node k-' + n.kind, tabindex: 0 }, svg);
        el('rect', { x, y, width: W, height: H, rx: 4 }, g);
        const t = el('text', { x: x + 6, y: y + 14 }, g); t.textContent = n.label.length > 32 ? n.label.slice(0, 31) + '…' : n.label;
        el('title', {}, g).textContent = n.kind + ': ' + (n.path || n.label);
        g.addEventListener('click', () => trace(n));
        g.addEventListener('keydown', e => { if (e.key === 'Enter') trace(n); });
        nodeEls.set(n.id, g);
      });
    });
    for (const e of graph.edges) {
      const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) continue;
      const [l, r] = a.x <= b.x ? [a, b] : [b, a];
      const x1 = l.x + W, y1 = l.y + H / 2, x2 = r.x, y2 = r.y + H / 2, mx = (x1 + x2) / 2;
      edgeEls.push({ e, path: el('path', { class: 'edge', d: 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 }, edges) });
    }
    document.getElementById('stats').textContent = graph.nodes.length + ' nodes, ' + graph.edges.length + ' edges';
  }

  function highlight(ids, edgeSet) {
    for (const [id, g] of nodeEls) g.classList.toggle('dim', ids !== null && !ids.has(id));
    for (const { e, path } of edgeEls) { const on = edgeSet !== null && edgeSet.has(e.from + '>' + e.to + '>' + e.kind); path.classList.toggle('on', on); path.classList.toggle('dim', edgeSet !== null && !on); }
  }

  function list(title, nodes) {
    if (!nodes.length) return;
    const h = document.createElement('h2'); h.textContent = title; detail.appendChild(h);
    const ul = document.createElement('ul');
    for (const n of nodes) { const li = document.createElement('li'); li.textContent = n.path || n.label; ul.appendChild(li); }
    detail.appendChild(ul);
  }

  function trace(node) {
    api('/api/trace?q=' + encodeURIComponent(node.id)).then(view => {
      highlight(new Set(view.nodes.map(n => n.id)), new Set(view.edges.map(e => e.from + '>' + e.to + '>' + e.kind)));
      for (const g of nodeEls.values()) g.classList.remove('hit');
      nodeEls.get(node.id)?.classList.add('hit');
      detail.replaceChildren();
      const h = document.createElement('h2'); h.textContent = node.kind + ': ' + node.label; detail.appendChild(h);
      if (node.path) { const p = document.createElement('p'); p.textContent = node.path; detail.appendChild(p); }
      for (const k of KINDS) list(k + 's', view.nodes.filter(n => n.kind === k && n.id !== node.id));
      const clear = document.createElement('button'); clear.textContent = 'Clear'; clear.addEventListener('click', () => { highlight(null, null); detail.replaceChildren(); }); detail.appendChild(clear);
    }).catch(err => { detail.textContent = 'Trace failed: ' + err.message; });
  }

  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    if (!s) return highlight(null, null);
    highlight(new Set(graph.nodes.filter(n => (n.label + ' ' + (n.path || '')).toLowerCase().includes(s)).map(n => n.id)), new Set());
  });
  const load = () => api('/api/graph').then(g => { graph = g; draw(); }).catch(err => { detail.textContent = 'Could not load the graph: ' + err.message; });
  document.getElementById('reload').addEventListener('click', load);
  load();
})();
</script>
</body>
</html>
`;
}
