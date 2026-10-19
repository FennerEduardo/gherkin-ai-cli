import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lineDiff, pendingVersions, resolveVersion } from '../../src/commands/review';
import { readInventoryFile, writeInventoryFile } from '../../src/core/inventory';
import { planWrites, sha256 } from '../../src/core/write-protection';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const GENERATED_V1 = 'line 1\nline 2\nline 3\n';
const EDITED = 'line 1\nline 2 edited by me\nline 3\n';
const GENERATED_V2 = 'line 1\nline 2\nline 3\nline 4 (new in the generator)\n';

function project() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-review-'));
  fs.mkdirSync(path.join(dir, 'out', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'src', 'a.ts'), EDITED);
  fs.writeFileSync(path.join(dir, 'out', 'src', 'a.ts.ghk-new'), GENERATED_V2);
  writeInventoryFile(path.join(dir, '.ghe', 'inventory.json'), { version: '2', executions: [], artifacts: [{ filePath: 'src/a.ts', checksum: sha256(GENERATED_V2) }] });
  return dir;
}

describe('ghk generate --review (4.10)', () => {
  it('diffs the edited file against its generated version', () => {
    const d = lineDiff(EDITED, GENERATED_V2);
    expect(d).toMatchObject({ added: 2, removed: 1 });
    expect(d.diff).toContain('- line 2 edited by me');
    expect(d.diff).toContain('+ line 4 (new in the generator)');
  });

  it('keeping my version declines that generated content: generate does not offer it again, but offers a new one', () => {
    const root = project();
    const [pending] = pendingVersions(root, './out');
    expect(pending).toMatchObject({ file: 'out/src/a.ts', artifact: 'src/a.ts', added: 2, removed: 1 });
    resolveVersion(root, pending, 'keep');
    expect(fs.existsSync(path.join(root, 'out/src/a.ts.ghk-new'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'out/src/a.ts'), 'utf8')).toBe(EDITED);
    const inventory = readInventoryFile(path.join(root, '.ghe/inventory.json')).artifacts;
    expect(inventory[0].declined).toBe(sha256(GENERATED_V2));

    const plan = (content: string) => planWrites([{ filePath: 'src/a.ts', content }], { cwd: root, outputDir: './out', inventory })[0];
    expect(plan(GENERATED_V2).action).toBe('unchanged');
    expect(plan(GENERATED_V1).action).toBe('side-by-side');
  });

  it('taking the generated version replaces the file and records it as generated', () => {
    const root = project();
    resolveVersion(root, pendingVersions(root, './out')[0], 'take');
    expect(fs.readFileSync(path.join(root, 'out/src/a.ts'), 'utf8')).toBe(GENERATED_V2);
    const [entry] = readInventoryFile(path.join(root, '.ghe/inventory.json')).artifacts;
    expect(entry).toMatchObject({ checksum: sha256(GENERATED_V2) });
    expect(entry.declined).toBeUndefined();
    expect(pendingVersions(root, './out')).toEqual([]);
  });
});
