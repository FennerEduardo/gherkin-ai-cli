/* ==========================================================================
   Plugin tooling (PLAN-3.3.0-reverse-plus EC-02, EC-03, EC-04): the SDK
   helpers analyzers receive, `ghk plugin new|verify|list|lock`, and
   integrity pinning.
   ========================================================================== */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handlePluginCommand } from '../../src/commands/plugin';
import { verifyPlugin, endpointKey } from '../../src/core/plugins/verify';
import { pluginIntegrity, writePluginLock } from '../../src/core/plugins/integrity';
import { pluginSdk } from '../../src/core/plugins/sdk';
import { evidenceId } from '../../src/core/reverse/evidence';
import { PluginRegistry } from '../../src/core/plugin-system';
import { PolicyError } from '../../src/core/errors';
import { resetOutputState } from '../../src/utils/output';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-plugins-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); process.exitCode = undefined; resetOutputState(); });

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(cwd); }
}

describe('the SDK helpers', () => {
  it('give plugins the ids and paths the built-in analyzers use', () => {
    expect(pluginSdk.evidenceId('http-endpoint', 'a.ts', 3, 'k')).toBe(evidenceId('http-endpoint', 'a.ts', 3, 'k'));
    expect(pluginSdk.normalisePath('/orders/:id')).toBe('/orders/{id}');
    expect(endpointKey('post', '/api/v1/orders/{orderId}')).toBe('POST /orders/{}');
  });
});

describe('ghk plugin new and verify', () => {
  for (const kind of ['analyzer', 'lint-rule', 'gateway'] as const) {
    it(`the ${kind} template passes the conformance kit as generated`, async () => {
      const dir = tmp();
      await inDir(dir, () => handlePluginCommand('new', [kind, `acme-${kind}`], { json: true }));
      const report = await verifyPlugin(path.join(dir, `acme-${kind}`));
      const failed = [...report.checks, ...report.analyzers.flatMap(a => a.checks), ...report.lintRules.flatMap(r => r.checks), ...report.gateways.flatMap(g => g.checks)].filter(c => !c.passed);
      expect(failed).toEqual([]);
      expect(report.passed).toBe(true);
      if (kind === 'analyzer') expect(report.analyzers[0]).toMatchObject({ declared: 'experimental', eligible: 'beta', fixtures: [expect.objectContaining({ f1: 1 })] });
    }, 60000);
  }

  it('fails a plugin that reads a secret, writes, is not deterministic and claims a maturity it did not earn', async () => {
    const dir = tmp();
    await inDir(dir, () => handlePluginCommand('new', ['analyzer', 'bad-analyzer'], { json: true }));
    const index = path.join(dir, 'bad-analyzer', 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8')
      .replace("maturity: 'experimental'", "maturity: 'beta'")
      .replace('const out = [];', "const out = []; try { fs.readFileSync(require('path').join(ctx.root, '.env'), 'utf8'); } catch {} fs.writeFileSync(require('path').join(ctx.root, 'cache.txt'), 'x');")
      .replace("key: m[1] + ' ' + p", "key: m[1] + ' ' + p + Math.random()")
      .replace("POST /orders placeOrder", 'POST /orders placeOrder'));
    fs.writeFileSync(path.join(dir, 'bad-analyzer', 'fixtures', 'example.expected.json'), JSON.stringify({ endpoints: ['POST /orders', 'GET /orders/{id}', 'POST /orders/{id}/cancel', 'DELETE /orders/{id}', 'PUT /orders/{id}', 'GET /orders'] }));
    const report = await verifyPlugin(path.join(dir, 'bad-analyzer'));
    const failed = report.analyzers[0].checks.filter(c => !c.passed).map(c => c.id);
    expect(failed).toEqual(expect.arrayContaining(['example: deterministic', 'example: no writes', 'example: no secret read', 'maturity is earned']));
    expect(report.passed).toBe(false);
    await inDir(dir, () => handlePluginCommand('verify', ['bad-analyzer'], { json: true }));
    expect(process.exitCode).toBe(4);
  }, 60000);
});

describe('ghk plugin list, lock and integrity', () => {
  it('lists what each plugin adds, pins its bytes, and refuses it once they change', async () => {
    const dir = tmp();
    await inDir(dir, () => handlePluginCommand('new', ['lint-rule', 'acme-lint'], { json: true }));
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ plugins: { load: ['./acme-lint/index.js'] } }));
    resetOutputState();
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as any);
    await inDir(dir, () => handlePluginCommand('list', [], { json: true }));
    const listed = JSON.parse(out.slice(out.indexOf('{')));
    expect(listed.plugins[0]).toMatchObject({ name: 'acme-lint', apiVersion: 2, from: './acme-lint/index.js', lintRules: ['ORG001'] });

    const lock = writePluginLock(dir, ['./acme-lint/index.js']);
    expect(lock.plugins['./acme-lint/index.js'].integrity).toBe(pluginIntegrity(path.join(dir, 'acme-lint', 'index.js'), true));
    // Unchanged bytes load; changed bytes are refused, with the policy exit code.
    const ok = new PluginRegistry();
    expect(ok.loadFromConfig({ plugins: { load: ['./acme-lint/index.js'] } } as any, dir)).toEqual(['./acme-lint/index.js']);
    fs.appendFileSync(path.join(dir, 'acme-lint', 'index.js'), '\n// tampered\n');
    const refused = new PluginRegistry();
    expect(() => refused.loadFromConfig({ plugins: { load: ['./acme-lint/index.js'] } } as any, dir)).toThrow(PolicyError);
    // plugins.integrity wins over the lock file.
    const pinned = new PluginRegistry();
    expect(() => pinned.loadFromConfig({ plugins: { load: ['./acme-lint/index.js'], integrity: { './acme-lint/index.js': pluginIntegrity(path.join(dir, 'acme-lint', 'index.js'), true) } } } as any, dir)).not.toThrow();
  }, 60000);
});
