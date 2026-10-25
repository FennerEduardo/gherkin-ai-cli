import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
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
    for (const entry of ['.ghe/*', '!.ghe/inventory.json', '.gherkin-ai/*', '!.gherkin-ai/constitution.yaml', 'node_modules/', 'target/', 'build/', '.gradle/', '**/obj/', '_build/']) expect(lines).toContain(entry);
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
    // The old whole-directory entry is replaced, so the constitution can be versioned.
    expect(lines).not.toContain('.gherkin-ai/');
    expect(lines.filter(l => l === '.gherkin-ai/*')).toHaveLength(1);
    expect(lines.filter(l => l === '!.gherkin-ai/constitution.yaml')).toHaveLength(1);
    // Same for .ghe/: the inventory (checksums of generated files) is versioned, the rest of the state is not.
    expect(lines).not.toContain('.ghe/');
    expect(lines.filter(l => l === '.ghe/*')).toHaveLength(1);
    expect(lines.filter(l => l === '!.ghe/inventory.json')).toHaveLength(1);
  });

  it('lets git track the inventory and nothing else in .ghe/', () => {
    ensureGitignore(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.ghe', 'cache'), { recursive: true });
    for (const f of ['.ghe/inventory.json', '.ghe/cache/ir.json', '.ghe/suggested_commit.md']) fs.writeFileSync(path.join(dir, f), '{}');
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir }).toString().split('\n').filter(Boolean);
    expect(untracked).toContain('.ghe/inventory.json');
    expect(untracked.filter(f => f.startsWith('.ghe/'))).toEqual(['.ghe/inventory.json']);
  });
});
