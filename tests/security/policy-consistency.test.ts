/* ==========================================================================
   One write policy (M-01): the agent firewall, the guardrails of the repair
   loops and the MCP governance check give the same verdict for the same path.

   The 3.2.0 code-verified report probed them with these paths: guardrails
   allowed migrations and infrastructure the firewall held for approval, and
   the MCP engine blocked src/.environment.ts but allowed secrets.ts.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentFirewall, loadFirewallPolicy } from '../../src/core/governance/agent-firewall';
import { validateGuardrails } from '../../src/core/guardrails';
import { AgentPolicyEngine } from '../../src/core/governance/agent-policy-engine';
import { classifyFile, writeVerdict } from '../../src/core/governance/policy-session';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-policy-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// [path, may an agent write it unattended?]
const PATHS: [string, boolean][] = [
  ['src/orders/order.service.ts', true],
  ['apps/api/migrations/001.sql', false],
  ['db/migrations/1.sql', false],
  ['apps/api/infrastructure/main.tf', false],
  ['src/.env', false],
  ['.env.production', false],
  ['config/secrets/prod.json', false],
  ['certs/server.key', false],
  ['.github/workflows/ci.yml', false],
  ['src/.environment.ts', true],
  ['docs/how-to-.env-file.md', true]
];

describe('one write policy for every entry point (M-01)', () => {
  it.each(PATHS)('%s → writable: %s (firewall and guardrails agree)', (file, writable) => {
    const firewall = new AgentFirewall(loadFirewallPolicy(dir, {})).evaluate({ kind: 'write', target: file });
    expect(firewall.verdict === 'ALLOW', `firewall: ${firewall.verdict} ${firewall.rule}`).toBe(writable);
    const guard = validateGuardrails({ action: 'generate_code', targetFiles: [file] }, dir);
    expect(guard.allowed, guard.violations.join('; ')).toBe(writable);
  });

  it('the MCP governance check never allows what the firewall denies, and uses the same matcher', () => {
    const engine = new AgentPolicyEngine(dir, { allowedPaths: ['**'], protectedPaths: [] });
    const result = (f: string) => engine.evaluateFileModifications([f]);
    for (const f of ['.env', 'src/.env', 'certs/server.key', 'config/secrets/prod.json']) expect(result(f).allowed, f).toBe(false);
    for (const f of ['src/.environment.ts', 'docs/how-to-.env-file.md']) expect(result(f).allowed, f).toBe(true); // 3.2.0: false positives
    for (const f of ['apps/api/migrations/001.sql', 'apps/api/infrastructure/main.tf']) expect(result(f).requiresApproval, f).toBe(true);
    // 3.2.0 allowed a root secrets.ts with the default policy: it is outside allowedPaths.
    expect(new AgentPolicyEngine(dir).evaluateFileModifications(['secrets.ts']).allowed).toBe(false);
  });

  it('a repair loop may not change what it is measured against: specs, contracts and tests', () => {
    const firewall = new AgentFirewall(loadFirewallPolicy(dir, {}));
    for (const [file, cls] of [['features/checkout.feature', 'spec'], ['contracts/orders/openapi.json', 'contract'], ['src/orders/order.service.spec.ts', 'test'], ['src/test/java/a/OrderSteps.java', 'test']]) {
      expect(classifyFile(file)).toBe(cls);
      expect(writeVerdict(firewall, file, 'agent').verdict, file).toBe('ALLOW');
      expect(writeVerdict(firewall, file, 'repair')).toMatchObject({ verdict: 'REQUIRE_APPROVAL', rule: `repair-protected: ${cls}` });
      expect(validateGuardrails({ action: 'generate_code', targetFiles: [file], mode: 'repair' }, dir).allowed, file).toBe(false);
    }
    expect(writeVerdict(firewall, 'src/orders/order.service.ts', 'repair').verdict).toBe('ALLOW');
  });
});
