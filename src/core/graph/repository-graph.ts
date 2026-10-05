/* ==========================================================================
   gherkin-ai-cli - Semantic repository graph

   Links the specification to the code that implements and tests it:

     feature ─declares→ scenario ─executes→ command ─emits→ event
        └─exposes→ endpoint            file ─implements→ command/event/endpoint
                                       test ─tests→ command/event/endpoint

   Spec nodes come from the IR of every .feature file. Code nodes come from a
   deterministic scan of source files for the domain symbols in every naming
   style (PlaceOrder, placeOrder, place_order, place-order). No LLM involved.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { parseGherkinText } from '../gherkin-parser';
import { buildIR } from '../ir-builder';
import { toCamel, toKebab, toPascal, toSnake } from '../../utils/naming';
import { resolveSpecDir } from '../../utils/spec-dir-resolver';

export type GraphNodeKind = 'feature' | 'scenario' | 'command' | 'event' | 'endpoint' | 'file' | 'test';
export type GraphEdgeKind = 'declares' | 'executes' | 'emits' | 'exposes' | 'implements' | 'tests';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Project-relative path (features, files and tests). */
  path?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface RepositoryGraph {
  version: 1;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<GraphNodeKind, number> & { scannedFiles: number; truncated: boolean };
}

export interface GraphOptions {
  /** Directory with the .feature files (default: features/ or specs/). */
  specDir?: string;
  /** Upper bound on scanned source files (default 20 000). */
  maxFiles?: number;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'bin', 'obj',
  '_build', 'deps', '.dart_tool', '.gradle', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gherkin-ai', '.ghe'
]);
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.py', '.go', '.java', '.kt', '.cs', '.rb', '.php', '.ex', '.exs',
  '.rs', '.dart', '.graphql', '.proto', '.yaml', '.yml', '.json', '.prisma', '.sql'
]);
const MAX_FILE_BYTES = 512 * 1024;
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|integration_test)\/|\.(test|spec)\.[a-z]+$|_test\.(go|exs|py|dart)$|_spec\.rb$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/i;

export function isTestPath(relPath: string): boolean {
  return TEST_PATH.test(relPath.replace(/\\/g, '/'));
}

function listFiles(root: string, predicate: (rel: string) => boolean, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (!predicate(rel)) continue;
      if (files.length >= limit) return { files, truncated: true };
      files.push(rel);
    }
  }
  return { files: files.sort(), truncated: false };
}

export function resolveFeatureDir(projectDir: string, specDir?: string): string | undefined {
  try {
    return resolveSpecDir(specDir, projectDir);
  } catch {
    return undefined;
  }
}

/** Naming variants a symbol may take in code. Only distinctive variants (>= 6 chars) are matched. */
export function symbolVariants(name: string): string[] {
  const variants = new Set([name, toPascal(name), toCamel(name), toSnake(name), toKebab(name), toSnake(name).toUpperCase()]);
  return [...variants].filter(v => v.length >= 6);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildRepositoryGraph(projectDir: string, options: GraphOptions = {}): RepositoryGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = (from: string, to: string, kind: GraphEdgeKind) => edges.set(`${from}|${kind}|${to}`, { from, to, kind });

  // 1. Specification nodes.
  const featureDir = resolveFeatureDir(projectDir, options.specDir);
  const featureFiles = featureDir ? listFiles(featureDir, rel => rel.endsWith('.feature'), 5000).files.map(f => path.join(featureDir, f)) : [];
  /** variant -> symbol node ids */
  const symbols = new Map<string, Set<string>>();
  const registerSymbol = (nodeId: string, name: string) => {
    for (const variant of symbolVariants(name)) {
      if (!symbols.has(variant)) symbols.set(variant, new Set());
      symbols.get(variant)!.add(nodeId);
    }
  };
  const featurePaths = new Set<string>();

  for (const file of featureFiles) {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    featurePaths.add(rel);
    let ir;
    try {
      ir = buildIR(parseGherkinText(fs.readFileSync(file, 'utf8')), rel);
    } catch {
      continue; // unparsable specs are reported by `ghk lint`
    }
    const featureId = addNode({ id: `feature:${rel}`, kind: 'feature', label: ir.featureName || rel, path: rel });
    const commandIds = new Map<string, string>();
    for (const command of ir.commands) {
      const id = addNode({ id: `command:${toSnake(command.name)}`, kind: 'command', label: toPascal(command.name) });
      commandIds.set(command.id, id);
      addEdge(featureId, id, 'declares');
      registerSymbol(id, command.name);
    }
    for (const event of ir.events) {
      const id = addNode({ id: `event:${toPascal(event.name)}`, kind: 'event', label: toPascal(event.name) });
      addEdge(featureId, id, 'declares');
      registerSymbol(id, event.name);
      for (const trigger of event.triggeredBy) {
        const commandId = commandIds.get(trigger);
        if (commandId) addEdge(commandId, id, 'emits');
      }
    }
    for (const endpoint of ir.apiEndpoints) {
      const id = addNode({ id: `endpoint:${endpoint.method} ${endpoint.path}`, kind: 'endpoint', label: `${endpoint.method} ${endpoint.path}` });
      addEdge(featureId, id, 'exposes');
      if (endpoint.operationId) registerSymbol(id, endpoint.operationId);
    }
    for (const scenario of ir.scenarios) {
      const id = addNode({ id: `scenario:${rel}#${scenario.name}`, kind: 'scenario', label: scenario.name });
      addEdge(featureId, id, 'declares');
      for (const command of scenario.commands) {
        const commandId = commandIds.get(command);
        if (commandId) addEdge(id, commandId, 'executes');
      }
    }
  }

  // 2. Code nodes: files that mention a domain symbol implement (or test) it.
  const limit = options.maxFiles ?? 20000;
  const { files, truncated } = listFiles(projectDir, rel => SOURCE_EXTENSIONS.has(path.extname(rel)) && !featurePaths.has(rel), limit);
  const variants = [...symbols.keys()].sort((a, b) => b.length - a.length);
  const pattern = variants.length > 0 ? new RegExp(`(?<![A-Za-z0-9_])(${variants.map(escapeRegex).join('|')})(?![A-Za-z0-9_])`, 'g') : undefined;

  if (pattern) {
    for (const rel of files) {
      const abs = path.join(projectDir, rel);
      let content: string;
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const matched = new Set<string>();
      for (const match of content.matchAll(pattern)) {
        for (const id of symbols.get(match[1]) ?? []) matched.add(id);
      }
      if (matched.size === 0) continue;
      const test = isTestPath(rel);
      const fileId = addNode({ id: `${test ? 'test' : 'file'}:${rel}`, kind: test ? 'test' : 'file', label: rel, path: rel });
      for (const id of matched) addEdge(fileId, id, test ? 'tests' : 'implements');
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const count = (kind: GraphNodeKind) => nodeList.filter(n => n.kind === kind).length;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodes: nodeList,
    edges: [...edges.values()].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
    stats: {
      feature: count('feature'),
      scenario: count('scenario'),
      command: count('command'),
      event: count('event'),
      endpoint: count('endpoint'),
      file: count('file'),
      test: count('test'),
      scannedFiles: files.length,
      truncated
    }
  };
}

/**
 * Traceability: every node connected to the nodes matching `query` (id, label or path),
 * following edges in both directions up to `depth` hops.
 */
export function traceGraph(graph: RepositoryGraph, query: string, depth = 3): { roots: GraphNode[]; nodes: GraphNode[]; edges: GraphEdge[] } {
  const q = query.toLowerCase();
  const normalized = toSnake(query);
  const roots = graph.nodes.filter(n =>
    n.id.toLowerCase() === q || n.label.toLowerCase() === q || n.path?.toLowerCase() === q.replace(/\\/g, '/') ||
    ((n.kind === 'command' || n.kind === 'event') && toSnake(n.label) === normalized)
  );
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    for (const id of [edge.from, edge.to]) {
      if (!adjacency.has(id)) adjacency.set(id, []);
      adjacency.get(id)!.push(edge);
    }
  }
  const seen = new Set(roots.map(r => r.id));
  const edges = new Set<GraphEdge>();
  let frontier = [...seen];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of adjacency.get(id) ?? []) {
        edges.add(edge);
        const other = edge.from === id ? edge.to : edge.from;
        // Do not fan out through feature nodes reached indirectly: they would pull in unrelated specs.
        if (!seen.has(other)) {
          seen.add(other);
          if (graph.nodes.find(n => n.id === other)?.kind !== 'feature') next.push(other);
        }
      }
    }
    frontier = next;
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return { roots, nodes: [...seen].map(id => byId.get(id)!).filter(Boolean), edges: [...edges] };
}

/**
 * The code a change to a feature may touch: the feature itself, the files and tests that implement
 * its symbols, and the directories that contain them (as `dir/**` globs).
 */
export function scopeForFeature(graph: RepositoryGraph, featurePath: string): { files: string[]; globs: string[] } {
  const rel = featurePath.replace(/\\/g, '/');
  const featureId = `feature:${rel}`;
  const symbolIds = new Set(graph.edges.filter(e => e.from === featureId).map(e => e.to));
  const files = new Set<string>([rel]);
  for (const edge of graph.edges) {
    if (symbolIds.has(edge.to) && (edge.kind === 'implements' || edge.kind === 'tests')) {
      const node = graph.nodes.find(n => n.id === edge.from);
      if (node?.path) files.add(node.path);
    }
  }
  const globs = new Set<string>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    globs.add(dir === '.' ? file : `${dir}/**`);
  }
  return { files: [...files].sort(), globs: [...globs].sort() };
}

export function graphToMermaid(graph: Pick<RepositoryGraph, 'nodes' | 'edges'>): string {
  const ids = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const shape: Record<GraphNodeKind, [string, string]> = {
    feature: ['[[', ']]'], scenario: ['(', ')'], command: ['[/', '/]'], event: ['{{', '}}'], endpoint: ['>', ']'], file: ['[', ']'], test: ['[(', ')]']
  };
  const label = (s: string) => s.replace(/"/g, "'");
  const lines = ['flowchart LR'];
  for (const node of graph.nodes) {
    const [open, close] = shape[node.kind];
    lines.push(`  ${ids.get(node.id)}${open}"${node.kind}: ${label(node.label)}"${close}`);
  }
  for (const edge of graph.edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) lines.push(`  ${ids.get(edge.from)} -->|${edge.kind}| ${ids.get(edge.to)}`);
  }
  return lines.join('\n') + '\n';
}

export function graphToDot(graph: Pick<RepositoryGraph, 'nodes' | 'edges'>): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const shape: Record<GraphNodeKind, string> = { feature: 'folder', scenario: 'ellipse', command: 'box', event: 'hexagon', endpoint: 'cds', file: 'note', test: 'component' };
  const lines = ['digraph ghk {', '  rankdir=LR;'];
  for (const node of graph.nodes) lines.push(`  ${q(node.id)} [label=${q(`${node.kind}: ${node.label}`)}, shape=${shape[node.kind]}];`);
  for (const edge of graph.edges) lines.push(`  ${q(edge.from)} -> ${q(edge.to)} [label=${q(edge.kind)}];`);
  lines.push('}');
  return lines.join('\n') + '\n';
}
