/* ==========================================================================
   gherkin-ai-cli - 'graph' command: semantic repository graph & traceability
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { PolicyError, UsageError } from '../core/errors';
import { startGraphServer } from '../core/graph/graph-server';
import { buildRepositoryGraph, graphToDot, graphToMermaid, scopeForFeature, traceGraph } from '../core/graph/repository-graph';
import { emitData, emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface GraphCommandOptions {
  format?: string;
  output?: string;
  trace?: string;
  scope?: string;
  depth?: string;
  json?: boolean;
  serve?: boolean;
  port?: string;
}

const FORMATS = ['summary', 'json', 'mermaid', 'dot'];

export async function handleGraphCommand(options: GraphCommandOptions = {}): Promise<void> {
  const format = options.json ? 'json' : (options.format ?? (options.output ? 'json' : 'summary'));
  if (!FORMATS.includes(format)) throw new UsageError(`Unknown graph format "${format}".`, { hint: `Use one of: ${FORMATS.join(', ')}.` });

  const cwd = process.cwd();
  if (options.serve) return serveGraph(cwd, options.port);
  const graph = buildRepositoryGraph(cwd, { specDir: process.env.GHK_SPEC_DIR });
  if (graph.stats.feature === 0) logger.warn('No .feature files found: the graph only contains code nodes. Use --spec-dir to point at your specifications.');
  if (graph.stats.truncated) logger.warn(`Scan stopped after ${graph.stats.scannedFiles} files; the graph is partial.`);

  if (options.scope) {
    const scope = scopeForFeature(graph, path.relative(cwd, path.resolve(cwd, options.scope)));
    if (format === 'json') return emitJson({ feature: options.scope, ...scope });
    logger.info(`Change scope for ${options.scope} (${scope.files.length} file(s)):`);
    for (const glob of scope.globs) console.log(`  ${glob}`);
    return;
  }

  const view = options.trace ? traceGraph(graph, options.trace, Number(options.depth ?? 3)) : undefined;
  if (view && view.roots.length === 0) throw new UsageError(`Nothing in the graph matches "${options.trace}".`, { hint: 'Trace a command, event, endpoint, scenario, feature path or file path.' });
  const subject = view ? { nodes: view.nodes, edges: view.edges } : graph;

  let rendered: string;
  switch (format) {
    case 'json':
      rendered = JSON.stringify(view ? { query: options.trace, roots: view.roots.map(r => r.id), ...subject } : graph, null, 2) + '\n';
      break;
    case 'mermaid':
      rendered = graphToMermaid(subject);
      break;
    case 'dot':
      rendered = graphToDot(subject);
      break;
    default:
      rendered = renderSummary(graph, view);
  }

  if (options.output) {
    const target = path.resolve(cwd, options.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rendered);
    logger.success(`Graph written to ${path.relative(cwd, target)} (${subject.nodes.length} nodes, ${subject.edges.length} edges).`);
    if (format === 'json' && options.json) emitJson({ output: path.relative(cwd, target), stats: graph.stats });
    return;
  }
  if (format === 'json') {
    emitJson(JSON.parse(rendered));
    return;
  }
  emitData(rendered);
}

/** `--serve`: the live graph in the browser until Ctrl+C (src/core/graph/graph-server.ts). */
async function serveGraph(cwd: string, port = '4300'): Promise<void> {
  if (process.env.CI === 'true') throw new PolicyError('graph --serve is disabled in CI environments.', { hint: 'Use --format json|mermaid|dot -o <file> instead.' });
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) throw new UsageError(`Invalid port number: ${port}`);
  const server = await startGraphServer(cwd, portNum, { specDir: process.env.GHK_SPEC_DIR });
  logger.success(`Traceability graph at ${server.url}`);
  logger.info('Bound to 127.0.0.1; the token in the URL authorizes this browser session. The graph is rebuilt on every reload. Press Ctrl+C to stop.');
  await new Promise<void>(resolve => process.once('SIGINT', () => void server.close().then(resolve)));
}

function renderSummary(graph: ReturnType<typeof buildRepositoryGraph>, view?: ReturnType<typeof traceGraph>): string {
  const lines: string[] = [];
  if (view) {
    lines.push(`Trace: ${view.roots.map(r => `${r.kind} ${r.label}`).join(', ')}`);
    for (const kind of ['feature', 'scenario', 'command', 'event', 'endpoint', 'file', 'test'] as const) {
      const nodes = view.nodes.filter(n => n.kind === kind);
      if (nodes.length === 0) continue;
      lines.push(`  ${kind}s:`);
      for (const node of nodes) lines.push(`    ${node.label}`);
    }
    return lines.join('\n') + '\n';
  }
  const s = graph.stats;
  lines.push(`Repository graph: ${s.feature} feature(s), ${s.scenario} scenario(s), ${s.command} command(s), ${s.event} event(s), ${s.endpoint} endpoint(s)`);
  lines.push(`Code: ${s.file} implementation file(s), ${s.test} test file(s) linked (${s.scannedFiles} scanned)`);
  const linked = new Set(graph.edges.filter(e => e.kind === 'implements').map(e => e.to));
  const tested = new Set(graph.edges.filter(e => e.kind === 'tests').map(e => e.to));
  const symbols = graph.nodes.filter(n => n.kind === 'command' || n.kind === 'event' || n.kind === 'endpoint');
  const unimplemented = symbols.filter(n => !linked.has(n.id));
  const untested = symbols.filter(n => !tested.has(n.id));
  if (unimplemented.length > 0) lines.push(`Not found in code: ${unimplemented.map(n => n.label).join(', ')}`);
  if (untested.length > 0) lines.push(`Not referenced by tests: ${untested.map(n => n.label).join(', ')}`);
  lines.push('Use --trace <symbol>, --scope <feature>, or --format json|mermaid|dot.');
  return lines.join('\n') + '\n';
}
