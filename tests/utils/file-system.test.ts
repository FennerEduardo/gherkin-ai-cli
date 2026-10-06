import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeGeneratedFile } from '../../src/utils/file-system';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-fs-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeGeneratedFile', () => {
  it.skipIf(process.platform === 'win32')('makes generated scripts (shebang) executable', () => {
    const script = path.join(dir, 'bin', 'rails');
    writeGeneratedFile(script, '#!/usr/bin/env ruby\nputs 1\n');
    expect(fs.statSync(script).mode & 0o111).toBe(0o111);
  });

  it.skipIf(process.platform === 'win32')('leaves other files non-executable', () => {
    const file = path.join(dir, 'src', 'app.ts');
    writeGeneratedFile(file, 'export {};\n');
    expect(fs.statSync(file).mode & 0o111).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('export {};\n');
  });
});
