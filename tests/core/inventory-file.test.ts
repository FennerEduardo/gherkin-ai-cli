import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InventoryManager, mergeArtifacts, readInventoryFile, writeInventoryFile } from '../../src/core/inventory';
import { readInventory } from '../../src/core/upgrade';

let dir: string;
const file = () => path.join(dir, '.ghe', 'inventory.json');
const config = { projectName: 'p', architecture: 'hexagonal', stack: {}, rules: {}, outputDir: './' } as any;
const execution = {
  featureName: 'Orders', featurePath: 'features/orders.feature', featureVersionHash: 'a', promptVersionHash: 'b',
  author: { name: 'x', email: 'x@y', source: 'env' as const }, command: 'ghk implement',
  stack: { language: 'java', framework: 'spring-boot', architecture: 'ddd', testing: 'junit' }, dockerSandbox: false, status: 'PROMPT_GENERATED' as const
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-inv-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('.ghe/inventory.json', () => {
  it('reads both legacy formats', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: '1.0', artifacts: [{ filePath: 'a.ts', checksum: 'c1' }] }));
    expect(readInventoryFile(file())).toMatchObject({ version: '2', artifacts: [{ filePath: 'a.ts' }], executions: [] });
    fs.writeFileSync(file(), JSON.stringify([{ ...execution, recordId: 'r1', timestamp: 't' }]));
    expect(readInventoryFile(file())).toMatchObject({ artifacts: [], executions: [{ recordId: 'r1' }] });
  });

  it('records an execution without losing generated-artifact checksums (implement after generate)', () => {
    writeInventoryFile(file(), { version: '2', artifacts: [{ filePath: 'src/a.ts', checksum: 'c1' }], executions: [] });
    const manager = new InventoryManager(dir, config);
    expect(manager.recordExecution(execution)).not.toBeNull();
    expect(manager.getInventory()).toHaveLength(1);
    expect(manager.getInventory('orders')).toHaveLength(1);
    expect(readInventory(dir)).toEqual([{ filePath: 'src/a.ts', checksum: 'c1' }]);
    manager.clearInventory();
    expect(manager.getInventory()).toHaveLength(0);
    expect(readInventory(dir)).toHaveLength(1);
  });

  it('upgrades a legacy array file when generate later merges artifacts', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify([{ ...execution, recordId: 'r1', timestamp: 't' }]));
    const previous = readInventoryFile(file());
    writeInventoryFile(file(), { ...previous, artifacts: mergeArtifacts(previous.artifacts, [{ filePath: 'x.ts', checksum: 'c' }]) });
    expect(readInventoryFile(file())).toMatchObject({ artifacts: [{ filePath: 'x.ts' }], executions: [{ recordId: 'r1' }] });
  });

  it('merges artifacts across features by path', () => {
    const first = mergeArtifacts([], [{ filePath: 'contracts\\orders.ts', checksum: '1', feature: 'orders' }, { filePath: 'openapi.json', checksum: '1' }]);
    const second = mergeArtifacts(first, [{ filePath: 'openapi.json', checksum: '2', feature: 'payments' }]);
    expect(second).toEqual([
      { filePath: 'contracts/orders.ts', checksum: '1', feature: 'orders' },
      { filePath: 'openapi.json', checksum: '2', feature: 'payments' }
    ]);
  });
});
