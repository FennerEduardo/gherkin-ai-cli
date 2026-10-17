import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleIndustryCommand } from '../../src/commands/industry';
import { loadFirewallPolicy } from '../../src/core/governance/agent-firewall';
import { UsageError } from '../../src/core/errors';

const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

const project = (config: object) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-industry-'));
  fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify(config, null, 2));
  return dir;
};

describe('ghk industry', () => {
  it('apply writes industry.id, keeps the rest of the config and writes the context files', async () => {
    const dir = project({ projectName: 'claims', architecture: 'monolith', outputDir: './' });
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleIndustryCommand('apply', 'seguros', {});

    const config = JSON.parse(fs.readFileSync(path.join(dir, 'gherkin-ai.config.json'), 'utf8'));
    expect(config).toMatchObject({ projectName: 'claims', architecture: 'monolith', industry: { id: 'insurance' } });
    expect(fs.readFileSync(path.join(dir, '.ghe/industry-context.md'), 'utf8')).toContain('ACORD');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.ghe/industry-context.json'), 'utf8')).id).toBe('insurance');
  });

  it('rejects unknown industries and subcommands with a usage error', async () => {
    await expect(handleIndustryCommand('show', 'mining', {})).rejects.toBeInstanceOf(UsageError);
    await expect(handleIndustryCommand('remove', 'health', {})).rejects.toBeInstanceOf(UsageError);
  });
});

describe('industry approval paths in the agent firewall', () => {
  it('adds the industry sensitive paths only when the project declares the industry', () => {
    const dir = project({});
    expect(loadFirewallPolicy(dir, { industry: { id: 'health' } }).approvalPaths).toContain('**/phi/**');
    expect(loadFirewallPolicy(dir, { domainProfile: 'payments' }).approvalPaths).not.toContain('**/payments/**');
  });
});

describe('industry in init and upgrade', () => {
  it('init --industry stores the industry, preselects its architecture and writes the context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-industry-init-'));
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handleInitCommand } = await import('../../src/commands/init');
    await handleInitCommand({ yes: true, industry: 'fhir', language: 'typescript', framework: 'nestjs' });
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'gherkin-ai.config.json'), 'utf8'));
    expect(config.industry).toEqual({ id: 'health' });
    expect(config.architecture).toBe('hexagonal');
    expect(fs.existsSync(path.join(dir, '.ghe/industry-context.md'))).toBe(true);
  });

  it('init without --industry writes no industry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-industry-init-'));
    process.chdir(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { handleInitCommand } = await import('../../src/commands/init');
    await handleInitCommand({ yes: true, language: 'typescript', framework: 'nestjs' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'gherkin-ai.config.json'), 'utf8')).industry).toBeUndefined();
  });

  it('upgrade suggests the industry a legacy domainProfile names, without applying it', async () => {
    const { checkProjectConfig } = await import('../../src/core/upgrade');
    const hint = checkProjectConfig({ domainProfile: 'payments' }, 'gherkin-ai.config.json').findings.find(f => f.id === 'config.industry-profile');
    expect(hint).toMatchObject({ severity: 'info', fix: 'none' });
    expect(hint?.hint).toContain('ghk industry apply banking');
    expect(checkProjectConfig({ domainProfile: 'payments', industry: { id: 'banking' } }, 'f').findings.some(f => f.id === 'config.industry-profile')).toBe(false);
  });
});
