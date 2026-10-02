import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertAgentWritesAllowed } from '../../src/core/governance/write-guard';
import { defaultConfig } from '../../src/core/config';
import { PolicyError } from '../../src/core/errors';
import { configureTelemetry } from '../../src/core/telemetry';

describe('agent write guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-guard-'));
    configureTelemetry(dir, {});
  });

  it('refuses unattended writes in CI unless explicitly allowed', () => {
    expect(() => assertAgentWritesAllowed(defaultConfig, { command: 'verify', ci: true, branch: 'feature/x' })).toThrow(PolicyError);
    expect(() => assertAgentWritesAllowed(defaultConfig, { command: 'verify', ci: true, branch: 'feature/x', allowUnattendedWrites: true })).not.toThrow();
    expect(() => assertAgentWritesAllowed({ ...defaultConfig, policy: { allowUnattendedWrites: true } }, { command: 'verify', ci: true, branch: 'feature/x' })).not.toThrow();
  });

  it('protects main/master by default and honors custom protected branches', () => {
    expect(() => assertAgentWritesAllowed(defaultConfig, { command: 'autopilot', ci: false, branch: 'main' })).toThrow(/protected branch/);
    expect(() => assertAgentWritesAllowed(defaultConfig, { command: 'autopilot', ci: false, branch: 'main', forceBranch: true })).not.toThrow();
    const config = { ...defaultConfig, policy: { protectedBranches: ['release'] } };
    expect(() => assertAgentWritesAllowed(config, { command: 'autopilot', ci: false, branch: 'main' })).not.toThrow();
    expect(() => assertAgentWritesAllowed(config, { command: 'autopilot', ci: false, branch: 'release' })).toThrow(PolicyError);
  });

  it('audits both allowed and blocked decisions', () => {
    assertAgentWritesAllowed(defaultConfig, { command: 'verify', ci: false, branch: 'feature/y' });
    expect(() => assertAgentWritesAllowed(defaultConfig, { command: 'verify', ci: true, branch: 'feature/y' })).toThrow();
    const records = fs.readFileSync(path.join(dir, '.gherkin-ai', 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(records.map(r => [r.action, r.status])).toEqual([['verify:agent-write', 'SUCCESS'], ['verify:agent-write', 'BLOCKED']]);
  });
});
