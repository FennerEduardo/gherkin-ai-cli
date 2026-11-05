/* ==========================================================================
   The gateway plugin templates of ghk expose (PLAN-3.3.0-reverse-plus EX-12):
   @gherkin-ai/expose-azure-apim and @gherkin-ai/expose-gcp, from plugins/.
   - they pass the conformance kit (ghk plugin verify);
   - loaded by a project's plugins.load, `expose plan` and `expose generate`
     use them next to the core providers;
   - they are not in the CLI package.
   Their Terraform is checked with terraform fmt/validate in Docker
   (~/ghk-gateway-plugins.sh; evidence in the informe), not here.
   ========================================================================== */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyPlugin } from '../../src/core/plugins/verify';
import { handleExposeCommand } from '../../src/commands/expose';
import { resetOutputState } from '../../src/utils/output';

const ROOT = path.join(__dirname, '..', '..');
const PLUGINS = ['expose-azure-apim', 'expose-gcp'];
const cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
  resetOutputState();
});

describe('gateway plugin templates (EX-12)', () => {
  it('pass the conformance kit, experimental, without claiming more than they declare', async () => {
    for (const name of PLUGINS) {
      const report = await verifyPlugin(path.join(ROOT, 'plugins', name));
      expect(report.passed, `${name}: ${JSON.stringify(report.gateways)}`).toBe(true);
      expect(report.gateways).toHaveLength(1);
      const provider = require(path.join(ROOT, 'plugins', name)).gatewayProviders()[0];
      expect(provider).toMatchObject({ tier: 'community', maturity: 'experimental' });
      expect(provider.capabilities()['per-tool-authz']).toBe('runtime');
    }
  });

  it('a project loads them: plan and generate use them next to the core providers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-gw-plugins-'));
    fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'expose', 'shop'), dir, { recursive: true });
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'gherkin-ai.config.json'), 'utf8'));
    // A relative path must stay inside the project: copy the plugins in, as a monorepo would vendor them.
    for (const n of PLUGINS) fs.cpSync(path.join(ROOT, 'plugins', n), path.join(dir, 'tools', n), { recursive: true });
    const load = PLUGINS.map(n => `./tools/${n}/index.js`);
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ ...config, plugins: { load, allow: load } }));
    process.chdir(dir);
    await handleExposeCommand('discover', [], {});
    await handleExposeCommand('approve', [], { all: true, env: ['dev'], yes: true, by: 'Ana' });
    for (const target of ['azure-apim', 'gcp-apigateway']) {
      await handleExposeCommand('plan', [], { target });
      expect(JSON.parse(fs.readFileSync(path.join(dir, `.ghe/expose/plan-${target}.json`), 'utf8'))).toMatchObject({ provider: target, tier: 'community', maturity: 'experimental', overclaimed: [] });
      await handleExposeCommand('generate', [], { target, discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', audience: ['shop-mcp'] });
      const tf = fs.readFileSync(path.join(dir, 'expose', target, 'main.tf'), 'utf8');
      expect(tf).toMatch(target === 'azure-apim' ? /validate-jwt/ : /x-google-jwks_uri/);
    }
  });

  it('are not in the CLI package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).not.toContain('plugins');
    for (const n of PLUGINS) expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', n, 'package.json'), 'utf8')).publishConfig).toEqual({ access: 'public' });
  });
});
