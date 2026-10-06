import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureGitignore } from '../../src/utils/gitignore-manager';

let dir: string;
const read = () => fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').map(l => l.trim());

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-gitignore-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ensureGitignore', () => {
  it('creates a .gitignore with gherkin-ai entries and build outputs', () => {
    ensureGitignore(dir);
    const lines = read();
    for (const entry of ['.ghe/', '.gherkin-ai/', 'node_modules/', 'target/', 'build/', '.gradle/', '**/obj/', '_build/']) expect(lines).toContain(entry);
    // Rails keeps real code in bin/: only .NET build folders are ignored.
    expect(lines).not.toContain('bin/');
    expect(lines).toContain('**/bin/Debug/');
  });

  it('appends missing build outputs to an existing file once', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.ghe/\n.gherkin-ai/\n*.log\n*.jsonl\ntelemetry.jsonl\n.env\n.env.local\ntarget/\n');
    ensureGitignore(dir);
    ensureGitignore(dir);
    const lines = read();
    expect(lines.filter(l => l === 'target/')).toHaveLength(1);
    expect(lines.filter(l => l === '.gradle/')).toHaveLength(1);
    expect(lines.filter(l => l === '# Build outputs')).toHaveLength(1);
  });
});
