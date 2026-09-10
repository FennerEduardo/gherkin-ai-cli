import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MonorepoAstIndexer } from '../../src/core/ast/monorepo-ast-indexer';

describe('MonorepoAstIndexer', () => {
  const tmpDir = path.join(process.cwd(), 'scratch', 'test-ast-indexer');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lazy loads source files into memory cache and manages cache size', () => {
    const file1 = path.join(tmpDir, 'file1.ts');
    const file2 = path.join(tmpDir, 'file2.ts');
    fs.writeFileSync(file1, 'export class User { id!: string; }', 'utf8');
    fs.writeFileSync(file2, 'export class Order { id!: string; }', 'utf8');

    const indexer = new MonorepoAstIndexer(tmpDir, { maxFilesInMemory: 1 });

    const sf1 = indexer.loadSourceFile(file1);
    expect(sf1).not.toBeNull();
    expect(sf1?.getClass('User')).toBeDefined();

    const sf2 = indexer.loadSourceFile(file2);
    expect(sf2).not.toBeNull();
    expect(sf2?.getClass('Order')).toBeDefined();

    indexer.clear();
  });
});
