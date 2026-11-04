/* ==========================================================================
   Golden G-P1 (PLAN-3.3.0-reverse-plus §4, EC-05): the official plugins
   @gherkin-ai/reverse-laravel and @gherkin-ai/reverse-rails, from plugins/.

   - each passes `ghk plugin verify` (the conformance kit) on its fixture;
   - loaded from a path by a project's plugins.load, its analyzer runs in
     `reverse scan`, is reported with the plugin's name, and its evidence
     becomes proposals that lint and round-trip;
   - pinned with `ghk plugin lock`, a changed plugin is refused (exit 5);
   - the plugins and their grammars are not in the CLI package.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyPlugin } from '../../src/core/plugins/verify';
import { runPropose, runScan } from '../../src/core/reverse';
import { pluginIntegrity, writePluginLock } from '../../src/core/plugins/integrity';
import { PluginRegistry } from '../../src/core/plugin-system';
import { PolicyError } from '../../src/core/errors';

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGINS = ['reverse-laravel', 'reverse-rails'];

describe('official reverse plugins (G-P1)', () => {
  for (const name of PLUGINS) {
    it(`${name} passes the conformance kit and earns the maturity it declares`, async () => {
      const report = await verifyPlugin(path.join(ROOT, 'plugins', name));
      const failed = [...report.checks, ...report.analyzers.flatMap(a => a.checks)].filter(c => !c.passed);
      expect(failed).toEqual([]);
      expect(report.analyzers[0]).toMatchObject({ declared: 'beta', eligible: 'beta' });
    }, 120000);
  }

  it('runs from a project plugins.load (a path), proposes features, and is refused once its bytes change', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-gp1-'));
    try {
      fs.cpSync(path.join(ROOT, 'plugins', 'reverse-laravel', 'fixtures', 'shop'), dir, { recursive: true });
      fs.cpSync(path.join(ROOT, 'plugins', 'reverse-laravel'), path.join(dir, 'tools', 'reverse-laravel'), { recursive: true, filter: src => !/[\\/]fixtures([\\/]|$)/.test(src) });
      fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ plugins: { load: ['./tools/reverse-laravel/index.js'] } }));
      const scan = await runScan(dir, { write: false });
      expect(scan.analyzers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'laravel/routes', plugin: '@gherkin-ai/reverse-laravel', maturity: 'beta' })]));
      const result = runPropose(dir, scan, { write: false });
      expect(result.candidates.map(c => c.operation.name)).toEqual(expect.arrayContaining(['PlaceOrder', 'CancelOrder', 'RefundOrder']));
      const cancel = result.candidates.find(c => c.operation.name === 'CancelOrder')!;
      expect(cancel.scenarios.map(s => s.name)).toEqual(expect.arrayContaining(['Cancelling the order fails when the order is not pending']));
      expect(result.candidates.find(c => c.operation.name === 'RefundOrder')!.scenarios.map(s => s.name)).toContain('A user without the manager role cannot refund the order');
      for (const p of result.proposals) { expect(p.lint.score, p.path).toBeGreaterThanOrEqual(80); expect(p.roundTrip.ok, p.path).toBe(true); }

      writePluginLock(dir, ['./tools/reverse-laravel/index.js']);
      fs.appendFileSync(path.join(dir, 'tools', 'reverse-laravel', 'index.js'), '\n// changed after the lock\n');
      expect(() => new PluginRegistry().loadFromConfig({ plugins: { load: ['./tools/reverse-laravel/index.js'] } } as any, dir)).toThrow(PolicyError);
      expect(pluginIntegrity(path.join(dir, 'tools', 'reverse-laravel', 'index.js'), true)).toMatch(/^sha512-/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120000);

  it('are not part of the CLI package', () => {
    const files: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
    expect(files.some(f => /^(plugins|packages)\b/.test(f))).toBe(false);
  });
});
