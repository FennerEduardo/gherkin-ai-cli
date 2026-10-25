/* ==========================================================================
   gherkin-ai-cli - Changes an agent makes in one run, and how they are undone

   - AgentChangeSet records every file an agent loop writes: the original
     content of files that existed, and the files it created. rollback()
     restores the first and deletes the second, whatever ended the loop
     (retry limit, circuit breaker, a stop rule, an exception).
   - Proposals (dry run, or a write the firewall did not ALLOW) are unified
     diffs in .ghe/patches, named after the file's path relative to the
     workspace, so src/button.ts and components/button.ts never collide.
     `git apply .ghe/patches/<name>.patch` applies one.
   ========================================================================== */

import { createTwoFilesPatch } from 'diff';
import fs from 'fs';
import path from 'path';

const posix = (p: string) => p.split(path.sep).join('/');

/** .ghe/patches/<path relative to the workspace, "/" as "__">.patch */
export function proposalPathFor(workspace: string, fullPath: string): string {
  const rel = posix(path.relative(workspace, path.resolve(workspace, fullPath)));
  const name = rel.startsWith('../') || path.isAbsolute(rel) ? `outside__${path.basename(fullPath)}` : rel.replace(/\//g, '__');
  return path.join(workspace, '.ghe', 'patches', `${name}.patch`);
}

/** Writes the proposed content as a unified diff against the file on disk (or /dev/null). Returns its path. */
export function writeProposal(workspace: string, fullPath: string, content: string): string {
  const rel = posix(path.relative(workspace, path.resolve(workspace, fullPath)));
  const exists = fs.existsSync(fullPath);
  const current = exists ? fs.readFileSync(fullPath, 'utf8') : '';
  const patch = createTwoFilesPatch(exists ? `a/${rel}` : '/dev/null', `b/${rel}`, current, content, '', '', { context: 3 });
  const target = proposalPathFor(workspace, fullPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, patch, 'utf8');
  return target;
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
  failed: { file: string; error: string }[];
}

export class AgentChangeSet {
  private readonly originals = new Map<string, Buffer>();
  private readonly created = new Set<string>();

  /** Call before writing `fullPath`; only its state before the first write is kept. */
  beforeWrite(fullPath: string): void {
    const key = path.resolve(fullPath);
    if (this.originals.has(key) || this.created.has(key)) return;
    if (fs.existsSync(key)) this.originals.set(key, fs.readFileSync(key));
    else this.created.add(key);
  }

  get size(): number {
    return this.originals.size + this.created.size;
  }

  /** Puts every recorded file back as it was before the run. */
  rollback(): RollbackResult {
    const result: RollbackResult = { restored: [], removed: [], failed: [] };
    for (const [file, content] of this.originals) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        result.restored.push(file);
      } catch (e: any) {
        result.failed.push({ file, error: e.message });
      }
    }
    for (const file of this.created) {
      try {
        fs.rmSync(file, { force: true });
        result.removed.push(file);
      } catch (e: any) {
        result.failed.push({ file, error: e.message });
      }
    }
    this.originals.clear();
    this.created.clear();
    return result;
  }
}
