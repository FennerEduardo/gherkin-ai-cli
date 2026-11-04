/* ==========================================================================
   Plugin API v2 (PLAN-3.3.0-reverse-plus EC-01): versioned compatibility and
   the extension points reverse analyzers, lint rules and gateway providers.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PluginRegistry } from '../../src/core/plugin-system';
import { incompatibility, satisfiesRange, PLUGIN_API_VERSION } from '../../src/core/plugins/compat';
import { runPropose, runScan } from '../../src/core/reverse';
import { ConfigError } from '../../src/core/errors';
import { CLI_VERSION } from '../../src/version';

describe('plugin compatibility', () => {
  it('reads npm-style ranges', () => {
    const ok = (r: string, v = '3.3.0') => satisfiesRange(v, r);
    expect([ok('*'), ok('3'), ok('3.3'), ok('3.3.0'), ok('^3.3'), ok('^3.0.1'), ok('~3.3.0'), ok('>=3.2 <4'), ok('^2 || ^3')]).toEqual([true, true, true, true, true, true, true, true, true]);
    expect([ok('^4'), ok('~3.2'), ok('<3.3'), ok('3.2'), ok('>=3.4')]).toEqual([false, false, false, false, false]);
  });

  it('refuses a plugin for a newer API or another gherkin-ai, and keeps v1 plugins working', () => {
    expect(incompatibility({ name: 'p', apiVersion: PLUGIN_API_VERSION + 1 }, CLI_VERSION)!.reason).toMatch(/needs plugin API 3/);
    expect(incompatibility({ name: 'p', engines: { 'gherkin-ai': '^4' } }, CLI_VERSION)!.reason).toMatch(/supports gherkin-ai \^4/);
    expect(incompatibility({ name: 'p' }, CLI_VERSION)).toBeUndefined();
    const registry = new PluginRegistry();
    registry.register({ name: 'legacy', version: '1.0.0', generate: () => [] });
    expect(() => registry.register({ name: 'future', version: '1.0.0', apiVersion: 3 as any })).toThrow(ConfigError);
    expect(registry.getPlugins().map(p => p.name)).toEqual(['legacy']);
  });

  it('collects the v2 extension points, each tagged with its plugin', () => {
    const registry = new PluginRegistry();
    registry.register({
      name: 'acme-standards', version: '1.0.0', apiVersion: 2, engines: { 'gherkin-ai': '^3.3' },
      lintRules: () => [{ id: 'ACME001', name: 'x', severity: 'info', check: () => [] }],
      reverseAnalyzers: () => [{ id: 'acme/routes', language: 'any', frameworks: ['acme'], maturity: 'experimental', detect: () => false, analyze: async () => [] }]
    });
    expect(registry.getLintRules().map(r => r.id)).toEqual(['ACME001']);
    expect(registry.getReverseAnalyzers().map(a => `${a.id}:${a.plugin}`)).toEqual(['acme/routes:acme-standards']);
    expect(registry.getGatewayProviders()).toEqual([]);
  });
});

describe('a plugin analyzer in ghk reverse', () => {
  it('runs from plugins.load, is reported with its plugin, and its evidence becomes a proposal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-plugin-'));
    try {
      fs.writeFileSync(path.join(dir, 'app.routes'), 'POST /widgets create a widget\n');
      fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ plugins: { load: ['./widgets-plugin.js'] } }));
      // A plugin as a team would write it: plain CommonJS, evidence as plain objects.
      fs.writeFileSync(path.join(dir, 'widgets-plugin.js'), `
module.exports = {
  name: 'widgets-routes', version: '0.1.0', apiVersion: 2, engines: { 'gherkin-ai': '^3.3' },
  reverseAnalyzers: () => [{
    id: 'widgets/routes', language: 'any', frameworks: ['widgets'], maturity: 'experimental', extensions: ['.routes'],
    detect: ctx => ctx.files.some(f => f.rel.endsWith('.routes')),
    analyze: async () => [
      { id: 'ev-widget0001', kind: 'http-endpoint', description: 'POST /widgets', location: { file: 'app.routes', startLine: 1, endLine: 1 }, extractor: 'widgets/routes', confidence: 'strong', references: [], metadata: { method: 'POST', path: '/widgets' } },
      { id: 'ev-widget0002', kind: 'success-response', description: 'responds 201', location: { file: 'app.routes', startLine: 1, endLine: 1 }, extractor: 'widgets/routes', confidence: 'strong', references: ['ev-widget0001'], metadata: { status: 201 } }
    ]
  }]
};
`);
      // `.routes` is not a source extension gherkin-ai reads: the analyzer asks discovery for it.
      const scan = await runScan(dir, { write: false });
      expect(scan.analyzers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'widgets/routes', maturity: 'experimental', plugin: 'widgets-routes', evidence: 2 })]));
      const result = runPropose(dir, scan, { write: false });
      expect(result.candidates.map(c => c.operation.name)).toEqual(['CreateWidget']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
