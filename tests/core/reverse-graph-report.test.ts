/* ==========================================================================
   `ghk reverse` with the rest of the CLI (PLAN-3.3.0-reverse-plus):
   - RV-17: the `# evidence:` comments of accepted features are edges of
     `ghk graph`, and `ghk impact --file` lists the scenarios a file backs;
   - RV-18: `reverse coverage --format markdown|html`.
   ========================================================================== */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readCandidates, runAccept, runCoverage, runPropose, runScan } from '../../src/core/reverse';
import { buildRepositoryGraph, evidenceFilesByScenario } from '../../src/core/graph/repository-graph';
import { coverageByAggregate, coverageHtml, coverageMarkdown } from '../../src/core/reverse/report';
import { handleImpactCommand } from '../../src/commands/impact';
import { clearTsProjects } from '../../src/core/reverse/analyzers/typescript/project';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'golden', 'brownfield-express');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function accepted(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-rv17-'));
  dirs.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'features'), { recursive: true, force: true });
  clearTsProjects();
  const scan = await runScan(dir);
  runPropose(dir, scan);
  runAccept(dir, scan, readCandidates(dir)!, { all: true, write: true });
  return dir;
}

describe('reverse evidence in graph and impact (RV-17)', () => {
  it('links every file a scenario cites to that scenario', async () => {
    const dir = await accepted();
    const feature = path.join(dir, 'features', 'discovered', 'order.feature');
    const byScenario = evidenceFilesByScenario(feature);
    expect(byScenario.get('Place an order')).toEqual(['docs/openapi.json', 'src/orders.js']);
    const graph = buildRepositoryGraph(dir);
    const edge = graph.edges.find(e => e.from === 'file:src/orders.js' && e.to === 'scenario:features/discovered/order.feature#Place an order');
    expect(edge?.kind).toBe('implements');
  }, 60000);

  it('ghk impact --file lists the scenarios that cite the file', async () => {
    const dir = await accepted();
    const cwd = process.cwd();
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
    process.chdir(dir);
    try { await handleImpactCommand({ file: 'src/orders.js', json: true }); } finally { process.chdir(cwd); }
    const report = JSON.parse(out.slice(out.indexOf('{')));
    expect(report.file).toBe('src/orders.js');
    expect(report.scenarios.filter((s: any) => s.via === 'evidence').map((s: any) => s.scenario)).toEqual(expect.arrayContaining(['Place an order', 'Cancel the order']));
  }, 60000);
});

describe('publishable coverage reports (RV-18)', () => {
  it('writes Markdown for a PR comment and one static HTML page, both by aggregate and by kind of entry point', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-rv18-'));
    dirs.push(dir);
    fs.cpSync(FIXTURE, dir, { recursive: true });
    clearTsProjects();
    const report = runCoverage(dir, await runScan(dir, { write: false }));
    expect(coverageByAggregate(report)[0]).toMatchObject({ aggregate: 'Order' });
    const md = coverageMarkdown(report);
    expect(md).toMatch(/^## Behaviour coverage\n\n\*\*\d+%\*\* of the \d+ operation\(s\)/);
    expect(md).toMatch(/\| Order \| \d+ \|/);
    const html = coverageHtml(report);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<title>Behaviour coverage<\/title>/);
    expect(html).toMatch(/prefers-color-scheme: dark/);
    // One page, nothing loaded from elsewhere.
    expect(html).not.toMatch(/<script|<link|https?:\/\//);
    // Two runs, the same bytes.
    expect(coverageHtml(report)).toBe(html);
  }, 60000);
});
