import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGenerateCommand } from '../../src/commands/generate';
import { handleKernelRefresh } from '../../src/commands/upgrade';
import { isKernelFile } from '../../src/core/upgrade/kernel-refresh';
import { readInventoryFile, writeInventoryFile } from '../../src/core/inventory';
import { sha256 } from '../../src/core/write-protection';

describe('kernel files', () => {
  it('recognises the runtime kernel of each stack', () => {
    for (const f of ['src/runtime/outbox-relay.ts', 'src/main/java/com/acme/runtime/CommandService.java', 'internal/runtime/relay.go', 'app/runtime/saga.py',
      'test/integration/runtime.int-spec.ts', 'src/test/java/com/acme/RuntimeIntegrationTest.java', 'tests/runtime_integration.rs']) {
      expect(isKernelFile(f), f).toBe(true);
    }
    for (const f of ['src/domain/order.ts', 'openapi.json', 'src/app.module.ts']) expect(isKernelFile(f), f).toBe(false);
  });
});

describe('ghk upgrade --kernel', () => {
  let dir: string;
  let cwd: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-kernel-'));
    cwd = process.cwd();
    process.chdir(dir);
    process.exitCode = undefined;
    for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    fs.writeFileSync('gherkin-ai.config.json', JSON.stringify({
      projectName: 'shop', architecture: 'hexagonal', outputDir: './',
      stack: { language: 'typescript', framework: 'nestjs', orm: 'none', database: 'postgresql', messaging: 'rabbitmq', validation: 'zod', auth: 'jwt', testing: 'jest' },
      rules: {}
    }));
    fs.mkdirSync('features');
    fs.writeFileSync('features/checkout.feature', 'Feature: Checkout\n  Scenario: Pay\n    Given a cart\n    When the customer pays the order\n    Then the order is paid\n    And an OrderPaid event is published\n');
    await handleGenerateCommand({ feature: 'features/checkout.feature', yes: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Makes `file` an older generated version: its content changes and its checksum is on record. */
  const makeStale = (file: string) => {
    const inv = readInventoryFile('.ghe/inventory.json');
    fs.writeFileSync(file, '// old kernel\n');
    inv.artifacts = inv.artifacts.map(a => (a.filePath === file ? { ...a, checksum: sha256('// old kernel\n') } : a));
    writeInventoryFile('.ghe/inventory.json', inv);
  };

  it('replaces unedited kernel files and leaves the rest alone', async () => {
    const kernelFiles = readInventoryFile('.ghe/inventory.json').artifacts.map(a => a.filePath).filter(isKernelFile);
    expect(kernelFiles.length).toBeGreaterThan(2);
    const [stale] = kernelFiles;
    makeStale(stale);
    const domainBefore = fs.readdirSync('.').sort();

    const [result] = await handleKernelRefresh({});
    expect(result.plans.find(p => p.filePath === stale)?.action).toBe('update');
    expect(fs.readFileSync(stale, 'utf8')).not.toBe('// old kernel\n');
    expect(result.plans.every(p => isKernelFile(p.filePath))).toBe(true);
    expect(fs.readdirSync('.').sort()).toEqual(domainBefore);
  });

  it('keeps the whole kernel as it is while one kernel file is edited (a half-new kernel does not compile)', async () => {
    const [stale, edited] = readInventoryFile('.ghe/inventory.json').artifacts.map(a => a.filePath).filter(isKernelFile);
    makeStale(stale);
    const editedContent = fs.readFileSync(edited, 'utf8') + '\n// my change\n';
    fs.writeFileSync(edited, editedContent);

    const [result] = await handleKernelRefresh({});
    const plan = (f: string) => result.plans.find(p => p.filePath === f);
    expect(plan(edited)?.action).toBe('side-by-side');
    expect(plan(stale)).toMatchObject({ action: 'side-by-side', held: true });
    expect(fs.readFileSync(edited, 'utf8')).toBe(editedContent);
    expect(fs.readFileSync(stale, 'utf8')).toBe('// old kernel\n');
    expect(fs.existsSync(`${edited}.ghk-new`)).toBe(true);
    expect(fs.existsSync(`${stale}.ghk-new`)).toBe(true);

    // The held file keeps its record: once the kernel is merged, it is still provably unedited.
    expect(readInventoryFile('.ghe/inventory.json').artifacts.find(a => a.filePath === stale)?.checksum).toBe(sha256('// old kernel\n'));
  });

  it('--dry-run writes nothing', async () => {
    const kernelFile = readInventoryFile('.ghe/inventory.json').artifacts.map(a => a.filePath).find(isKernelFile) as string;
    fs.writeFileSync(kernelFile, 'edited');
    await handleKernelRefresh({ dryRun: true });
    expect(fs.readFileSync(kernelFile, 'utf8')).toBe('edited');
    expect(fs.existsSync(`${kernelFile}.ghk-new`)).toBe(false);
  });
});
