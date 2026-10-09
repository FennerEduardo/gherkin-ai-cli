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

  it('replaces unedited kernel files, keeps edited ones and leaves the rest alone', async () => {
    const kernelFiles = readInventoryFile('.ghe/inventory.json').artifacts.map(a => a.filePath).filter(isKernelFile);
    expect(kernelFiles.length).toBeGreaterThan(2);
    const [stale, edited] = kernelFiles;

    // `stale` is an older generated version (its checksum is on record); `edited` was changed by the developer.
    const inv = readInventoryFile('.ghe/inventory.json');
    fs.writeFileSync(stale, '// old kernel\n');
    inv.artifacts = inv.artifacts.map(a => (a.filePath === stale ? { ...a, checksum: sha256('// old kernel\n') } : a));
    writeInventoryFile('.ghe/inventory.json', inv);
    const editedContent = fs.readFileSync(edited, 'utf8') + '\n// my change\n';
    fs.writeFileSync(edited, editedContent);
    const domainBefore = fs.readdirSync('.').sort();

    const [result] = await handleKernelRefresh({});
    const action = (f: string) => result.plans.find(p => p.filePath === f)?.action;
    expect(action(stale)).toBe('update');
    expect(action(edited)).toBe('side-by-side');
    expect(fs.readFileSync(stale, 'utf8')).not.toBe('// old kernel\n');
    expect(fs.readFileSync(edited, 'utf8')).toBe(editedContent);
    expect(fs.existsSync(`${edited}.ghk-new`)).toBe(true);
    expect(result.plans.every(p => isKernelFile(p.filePath))).toBe(true);
    expect(fs.readdirSync('.').sort()).toEqual(domainBefore);
  });

  it('--dry-run writes nothing', async () => {
    const kernelFile = readInventoryFile('.ghe/inventory.json').artifacts.map(a => a.filePath).find(isKernelFile) as string;
    fs.writeFileSync(kernelFile, 'edited');
    await handleKernelRefresh({ dryRun: true });
    expect(fs.readFileSync(kernelFile, 'utf8')).toBe('edited');
    expect(fs.existsSync(`${kernelFile}.ghk-new`)).toBe(false);
  });
});
