import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentChangeSet, proposalPathFor, writeProposal } from '../../src/core/governance/agent-changes';

describe('agent changes', () => {
  let dir: string;
  const file = (rel: string) => path.join(dir, rel);
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-agent-changes-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rolls back edited files and deletes the files the agent created', () => {
    put('src/a.ts', 'original a');
    const changes = new AgentChangeSet();
    for (const [rel, content] of [['src/a.ts', 'agent v1'], ['src/new/b.ts', 'agent b'], ['src/a.ts', 'agent v2']]) {
      changes.beforeWrite(file(rel));
      put(rel, content);
    }
    expect(changes.size).toBe(2);

    const undone = changes.rollback();
    expect(fs.readFileSync(file('src/a.ts'), 'utf8')).toBe('original a'); // the state before the first write
    expect(fs.existsSync(file('src/new/b.ts'))).toBe(false);
    expect(undone).toMatchObject({ restored: [file('src/a.ts')], removed: [file('src/new/b.ts')], failed: [] });
    expect(changes.size).toBe(0);
  });

  it('names proposals after the relative path, so equal basenames never collide (M-05)', () => {
    expect(proposalPathFor(dir, file('src/button.ts'))).not.toBe(proposalPathFor(dir, file('components/button.ts')));
    expect(path.basename(proposalPathFor(dir, file('src/ui/button.ts')))).toBe('src__ui__button.ts.patch');
  });

  it('writes a unified diff that git apply takes', () => {
    put('src/a.ts', 'line 1\nline 2\nline 3\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // The patch format is under test, not the machine's line-ending policy (Windows runners set autocrlf/safecrlf globally).
    for (const [key, value] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.eol', 'lf']]) execFileSync('git', ['config', key, value], { cwd: dir });
    const edit = writeProposal(dir, file('src/a.ts'), 'line 1\nline two\nline 3\n');
    const create = writeProposal(dir, file('src/b.ts'), 'export const b = 1;\n');
    for (const patch of [edit, create]) {
      try {
        execFileSync('git', ['apply', '--verbose', patch], { cwd: dir, stdio: 'pipe' });
      } catch (e: any) {
        throw new Error(`git apply ${path.basename(patch)} failed:\n${e.stderr}\n--- patch ---\n${fs.readFileSync(patch, 'utf8')}`);
      }
    }
    expect(fs.readFileSync(file('src/a.ts'), 'utf8')).toBe('line 1\nline two\nline 3\n');
    expect(fs.readFileSync(file('src/b.ts'), 'utf8')).toBe('export const b = 1;\n');
  });
});
