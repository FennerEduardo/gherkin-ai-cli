/* ==========================================================================
   gherkin-ai-cli - The plugin conformance kit (`ghk plugin verify`,
   PLAN-3.3.0-reverse-plus EC-03)

   A plugin directory is checked against the rules the built-in analyzers,
   lint rules and gateway providers follow:

   Analyzers, on every fixture in `fixtures/<name>/` (with the expected
   endpoints in `fixtures/<name>.expected.json`):
   - detect() recognises its own fixture;
   - two runs give byte-identical evidence (stable ids);
   - every item has an id, a known kind, a location inside the fixture, an
     extractor and a confidence;
   - nothing is written, and nothing is read outside the fixture: a secret
     file (`.env`) is planted next to the code and must never be opened
     (fs is watched while the analyzer runs);
   - endpoint precision, recall and F1 against the expected endpoints, which
     decide the maturity it may claim (beta ≥ 0.80, experimental ≥ 0.60).
   Lint rules: ids of their own (not GHKnnn), unique, and a check that
   returns diagnostics on a sample feature. Gateway providers: every control
   declared, a deterministic plan and emit, no control claimed `native` that
   capabilities() does not declare native, and emitted paths inside their
   directory; with `runTools`, the provider's validateCommand on the files.
   ========================================================================== */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { PluginRegistry, type GherkinAIPlugin } from '../plugin-system';
import { incompatibility, PLUGIN_API_VERSION } from './compat';
import { pluginSdk } from './sdk';
import { discoverSources } from '../reverse/discovery';
import type { SourceAnalyzer } from '../reverse/registry';
import type { SourceEvidence } from '../reverse/evidence';
import { parseGherkinText } from '../gherkin-parser';
import type { ExposeControl, GatewayProvider, ProviderManifestView } from '../expose/provider-types';
import { CLI_VERSION } from '../../version';

export interface Check { id: string; passed: boolean; detail?: string }
export interface FixtureResult { fixture: string; expected: number; found: number; matched: number; precision: number; recall: number; f1: number; missing: string[]; unexpected: string[] }
export interface AnalyzerReport { id: string; declared: string; eligible: 'beta' | 'experimental' | 'none'; fixtures: FixtureResult[]; checks: Check[] }
export interface VerifyReport {
  plugin: { name: string; version: string; apiVersion: number; engines?: string; dir: string };
  checks: Check[];
  analyzers: AnalyzerReport[];
  lintRules: { id: string; checks: Check[] }[];
  gateways: { id: string; checks: Check[] }[];
  passed: boolean;
}

const KINDS = new Set(['http-endpoint', 'input-contract', 'validation-rule', 'authorization-rule', 'service-call', 'repository-query', 'entity', 'state-value', 'domain-event', 'error-condition', 'success-response', 'test-case', 'message-handler', 'scheduled-job', 'rpc-operation', 'external-integration', 'persistence-constraint']);
const CONTROLS: ExposeControl[] = ['inbound-auth', 'per-tool-authz', 'tenant-isolation', 'outbound-credentials', 'rate-limit', 'human-approval', 'audit', 'private-network', 'tool-discovery'];
const SECRET = 'GHK_CANARY_SECRET=do-not-read-0123456789';

/** `POST /api/v1/orders/{id}` → `POST /orders/{}`: prefixes and parameter names do not count. */
export function endpointKey(method: string, p: string): string {
  const parts = p.split('/').filter(Boolean).filter((s, i) => !(i < 2 && /^(api|v\d+)$/i.test(s))).map(s => (/^\{.*\}$|^:/.test(s) ? '{}' : s.toLowerCase()));
  return `${method.toUpperCase()} /${parts.join('/')}`;
}

function score(expected: string[], found: string[]) {
  const e = new Set(expected.map(x => { const [m, ...rest] = x.trim().split(/\s+/); return endpointKey(m, rest.join(' ')); }));
  const f = new Set(found);
  const matched = [...e].filter(x => f.has(x)).length;
  const precision = f.size ? matched / f.size : 0;
  const recall = e.size ? matched / e.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { expected: e.size, found: f.size, matched, precision: r(precision), recall: r(recall), f1: r(f1), missing: [...e].filter(x => !f.has(x)).sort(), unexpected: [...f].filter(x => !e.has(x)).sort() };
}

/** Runs `fn` while watching fs: every write, and every read outside `root` (the plugin's own files are allowed). */
async function watchFs<T>(root: string, allowed: string[], fn: () => Promise<T>): Promise<{ result: T; writes: string[]; outside: string[]; secrets: string[] }> {
  const writes: string[] = [];
  const outside: string[] = [];
  const secrets: string[] = [];
  const inside = (p: string) => [root, ...allowed].some(r => path.resolve(String(p)).startsWith(path.resolve(r)));
  const onRead = (p: unknown) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return;
    // fileURLToPath, not URL.pathname: on Windows the pathname is /D:/a/..., which path.resolve turns into D:\D:\a\...
    const abs = path.resolve(p instanceof URL ? fileURLToPath(p) : p.startsWith('file:') ? fileURLToPath(p) : p);
    if (/(^|[\\/])\.env(\.|$)/.test(abs)) secrets.push(abs);
    else if (!inside(abs)) outside.push(abs);
  };
  const original = { readFileSync: fs.readFileSync, readFile: fs.promises.readFile, writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, mkdirSync: fs.mkdirSync, rmSync: fs.rmSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, writeFile: fs.promises.writeFile };
  const fsAny = fs as any;
  fsAny.readFileSync = (p: any, ...rest: any[]) => { onRead(p); return (original.readFileSync as any)(p, ...rest); };
  fsAny.promises.readFile = (p: any, ...rest: any[]) => { onRead(p); return (original.readFile as any)(p, ...rest); };
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'unlinkSync'] as const) {
    fsAny[name] = (p: any, ...rest: any[]) => { writes.push(`${name} ${String(p)}`); return (original[name] as any)(p, ...rest); };
  }
  fsAny.promises.writeFile = (p: any, ...rest: any[]) => { writes.push(`writeFile ${String(p)}`); return (original.writeFile as any)(p, ...rest); };
  try {
    const result = await fn();
    return { result, writes, outside: [...new Set(outside)], secrets: [...new Set(secrets)] };
  } finally {
    Object.assign(fs, { readFileSync: original.readFileSync, writeFileSync: original.writeFileSync, appendFileSync: original.appendFileSync, mkdirSync: original.mkdirSync, rmSync: original.rmSync, renameSync: original.renameSync, unlinkSync: original.unlinkSync });
    fsAny.promises.readFile = original.readFile;
    fsAny.promises.writeFile = original.writeFile;
  }
}

const stable = (evidence: SourceEvidence[]) => JSON.stringify([...evidence].sort((a, b) => a.id.localeCompare(b.id)));

async function verifyAnalyzer(a: SourceAnalyzer, pluginDir: string): Promise<AnalyzerReport> {
  const checks: Check[] = [];
  const fixturesDir = path.join(pluginDir, 'fixtures');
  const fixtures = fs.existsSync(fixturesDir) ? fs.readdirSync(fixturesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() : [];
  checks.push({ id: 'has-fixture', passed: fixtures.length > 0, detail: fixtures.length ? `${fixtures.length} fixture(s)` : 'add fixtures/<name>/ with code the analyzer reads, and fixtures/<name>.expected.json' });
  checks.push({ id: 'declares-maturity', passed: a.maturity === 'beta' || a.maturity === 'experimental', detail: String(a.maturity) });
  const results: FixtureResult[] = [];
  const cliRoot = path.resolve(__dirname, '..', '..', '..');
  for (const name of fixtures) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-plugin-verify-'));
    try {
      fs.cpSync(path.join(fixturesDir, name), tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), `${SECRET}\n`);
      const discovery = discoverSources(tmp, { extensions: a.extensions });
      const ctx = { root: tmp, files: discovery.files, includeTests: true, sdk: pluginSdk };
      const detected = a.detect(ctx);
      checks.push({ id: `${name}: detect`, passed: detected, detail: detected ? undefined : 'detect() returns false on its own fixture' });
      if (!detected) continue;
      const first = await watchFs(tmp, [pluginDir, cliRoot], () => a.analyze(ctx));
      const second = await watchFs(tmp, [pluginDir, cliRoot], () => a.analyze(ctx));
      checks.push({ id: `${name}: deterministic`, passed: stable(first.result) === stable(second.result), detail: stable(first.result) === stable(second.result) ? undefined : 'two runs on the same files give different evidence: build ids with ctx.sdk.makeEvidence and keep the order stable' });
      checks.push({ id: `${name}: no writes`, passed: !first.writes.length, detail: first.writes.slice(0, 3).join('; ') || undefined });
      checks.push({ id: `${name}: no secret read`, passed: !first.secrets.length, detail: first.secrets.length ? 'opened a .env file: read only ctx.files' : undefined });
      checks.push({ id: `${name}: reads only the project`, passed: !first.outside.length, detail: first.outside.slice(0, 3).join('; ') || undefined });
      checks.push({ id: `${name}: no secret in the output`, passed: !JSON.stringify(first.result).includes('GHK_CANARY_SECRET') });
      const bad = first.result.filter(e => !e?.id || !KINDS.has(e.kind) || !e.location?.file || !(e.location.startLine > 0) || !e.extractor || !['confirmed', 'strong', 'inferred', 'unknown'].includes(e.confidence) || !Array.isArray(e.references) || !fs.existsSync(path.join(tmp, e.location.file)));
      checks.push({ id: `${name}: evidence shape`, passed: !bad.length, detail: bad.length ? `${bad.length} item(s) without a valid id, kind, location in the fixture, extractor, confidence or references (first: ${JSON.stringify(bad[0]).slice(0, 160)})` : undefined });
      const extractors = new Set(first.result.map(e => e.extractor));
      checks.push({ id: `${name}: extractor is the analyzer id`, passed: [...extractors].every(x => x === a.id), detail: [...extractors].filter(x => x !== a.id).join(', ') || undefined });
      const expectedFile = path.join(fixturesDir, `${name}.expected.json`);
      const expected: string[] = fs.existsSync(expectedFile) ? (JSON.parse(fs.readFileSync(expectedFile, 'utf8')).endpoints ?? []) : [];
      if (!expected.length) { checks.push({ id: `${name}: expected endpoints`, passed: false, detail: `add ${path.relative(pluginDir, expectedFile)} with { "endpoints": ["POST /orders", …] }` }); continue; }
      const found = [...new Set(first.result.filter(e => e.kind === 'http-endpoint').map(e => endpointKey(String((e.metadata as any)?.method ?? ''), String((e.metadata as any)?.path ?? ''))))];
      results.push({ fixture: name, ...score(expected, found) });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const lowest = results.length ? Math.min(...results.map(r => r.f1)) : 0;
  const eligible = lowest >= 0.8 ? 'beta' : lowest >= 0.6 ? 'experimental' : 'none';
  checks.push({ id: 'maturity is earned', passed: eligible !== 'none' && (a.maturity !== 'beta' || eligible === 'beta'), detail: `declares ${a.maturity}; lowest F1 ${lowest.toFixed(2)} allows ${eligible}` });
  return { id: a.id, declared: a.maturity, eligible, fixtures: results, checks };
}

const SAMPLE_FEATURE = 'Feature: Orders\n  Scenario: Place an order\n    Given a signed-in customer\n    When the customer places an order\n    Then the order is placed\n';
const SAMPLE_MANIFEST: ProviderManifestView = {
  service: 'orders',
  capabilities: [
    { id: 'orders.list', name: 'ListOrders', description: 'Lists the orders.', effect: 'read', status: 'approved', authorization: { scopes: ['orders:read'], roles: [] }, execution: { approval: 'none' } },
    { id: 'orders.place', name: 'PlaceOrder', description: 'Places an order.', effect: 'write', status: 'approved', authorization: { scopes: ['orders:write'], roles: ['customer'] }, execution: { approval: 'human' } }
  ]
};

function verifyGateway(g: GatewayProvider, runTools: boolean): { id: string; checks: Check[] } {
  const checks: Check[] = [];
  const caps = g.capabilities();
  const missing = CONTROLS.filter(c => !['native', 'runtime', 'unsupported'].includes(caps[c]));
  checks.push({ id: 'every control declared', passed: !missing.length, detail: missing.join(', ') || undefined });
  const options = { environment: 'dev', image: 'example.invalid/mcp-runtime:verify', audiences: ['verify'] };
  const plan = JSON.stringify(g.plan(SAMPLE_MANIFEST, options));
  checks.push({ id: 'plan is deterministic', passed: plan === JSON.stringify(g.plan(SAMPLE_MANIFEST, options)) });
  const overclaimed = (JSON.parse(plan).tools ?? []).flatMap((t: any) => Object.entries(t.controls ?? {}).filter(([c, v]) => v === 'native' && caps[c as ExposeControl] !== 'native').map(([c]) => `${t.tool}: ${c}`));
  checks.push({ id: 'no control claimed beyond capabilities()', passed: !overclaimed.length, detail: overclaimed.join(', ') || undefined });
  const files = g.emit(SAMPLE_MANIFEST, options);
  checks.push({ id: 'emit is deterministic', passed: JSON.stringify(files) === JSON.stringify(g.emit(SAMPLE_MANIFEST, options)) });
  const escaping = files.filter(f => path.isAbsolute(f.path) || f.path.split(/[\\/]/).includes('..'));
  checks.push({ id: 'emitted paths stay in their directory', passed: !escaping.length && files.length > 0, detail: escaping.map(f => f.path).join(', ') || (files.length ? undefined : 'emit() returned no file') });
  if (runTools && g.validateCommand?.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-gateway-verify-'));
    try {
      for (const f of files) { fs.mkdirSync(path.dirname(path.join(tmp, f.path)), { recursive: true }); fs.writeFileSync(path.join(tmp, f.path), f.content); }
      const [cmd, ...args] = g.validateCommand;
      const r = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', timeout: 300_000 });
      checks.push({ id: `${g.validateCommand.join(' ')}`, passed: r.status === 0, detail: r.status === 0 ? undefined : (r.error?.message ?? (r.stderr || r.stdout).slice(-400)) });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { id: g.id, checks };
}

/** Loads the plugin in `dir` into a registry of its own (never the CLI's) and runs the kit. */
export async function verifyPlugin(dir: string, options: { runTools?: boolean } = {}): Promise<VerifyReport> {
  const pluginDir = path.resolve(dir);
  const pkgFile = path.join(pluginDir, 'package.json');
  const entry = fs.existsSync(pkgFile) ? path.resolve(pluginDir, JSON.parse(fs.readFileSync(pkgFile, 'utf8')).main ?? 'index.js') : path.join(pluginDir, 'index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(entry);
  const plugin: GherkinAIPlugin = mod?.default?.name ? mod.default : mod?.plugin ?? mod;
  const checks: Check[] = [];
  checks.push({ id: 'exports a plugin', passed: typeof plugin?.name === 'string' && typeof plugin?.version === 'string', detail: `${entry}` });
  const problem = incompatibility(plugin, CLI_VERSION);
  checks.push({ id: 'compatible with this gherkin-ai', passed: !problem, detail: problem?.reason });
  checks.push({ id: 'declares apiVersion and engines', passed: plugin.apiVersion === PLUGIN_API_VERSION && Boolean(plugin.engines?.['gherkin-ai']), detail: 'apiVersion: 2 and engines: { "gherkin-ai": "^3.3" }' });
  const registry = new PluginRegistry();
  if (!problem) registry.register(plugin);
  const analyzers: AnalyzerReport[] = [];
  for (const a of registry.getReverseAnalyzers()) analyzers.push(await verifyAnalyzer(a, pluginDir));
  const lintRules = registry.getLintRules().map(rule => {
    const c: Check[] = [];
    c.push({ id: 'own id (not GHKnnn)', passed: /^[A-Z][A-Z0-9]*\d{3}$/.test(rule.id) && !/^GHK\d{3}$/.test(rule.id), detail: rule.id });
    c.push({ id: 'severity', passed: ['error', 'warning', 'info'].includes(rule.severity) });
    let ok = false;
    try { ok = Array.isArray(rule.check(parseGherkinText(SAMPLE_FEATURE), {})); } catch { ok = false; }
    c.push({ id: 'check() returns diagnostics', passed: ok });
    return { id: rule.id, checks: c };
  });
  const ids = registry.getLintRules().map(r => r.id);
  if (new Set(ids).size !== ids.length) checks.push({ id: 'lint rule ids are unique', passed: false });
  const gateways = registry.getGatewayProviders().map(g => verifyGateway(g, Boolean(options.runTools)));
  checks.push({ id: 'contributes something', passed: analyzers.length + lintRules.length + gateways.length > 0, detail: 'reverseAnalyzers(), lintRules() or gatewayProviders()' });
  const passed = [...checks, ...analyzers.flatMap(a => a.checks), ...lintRules.flatMap(r => r.checks), ...gateways.flatMap(g => g.checks)].every(c => c.passed);
  return { plugin: { name: plugin?.name, version: plugin?.version, apiVersion: plugin?.apiVersion ?? 1, engines: plugin?.engines?.['gherkin-ai'], dir: pluginDir }, checks, analyzers, lintRules, gateways, passed };
}
