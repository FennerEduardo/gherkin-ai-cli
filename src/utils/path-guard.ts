/* ==========================================================================
   gherkin-ai-cli - Path containment checks

   `target.startsWith(root)` is NOT a containment check: "/repo-evil" starts
   with "/repo". Always use isPathInside / assertPathInside.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { PolicyError } from '../core/errors';

function realOrResolved(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Target may not exist yet: resolve its nearest existing parent so symlinked parents are still caught.
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(realOrResolved(parent), path.basename(resolved));
  }
}

/** True when `target` is `root` itself or a descendant of it (symlinks resolved). */
export function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(realOrResolved(root), realOrResolved(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertPathInside(root: string, target: string, what = 'Path'): string {
  const resolved = path.resolve(root, target);
  if (!isPathInside(root, resolved)) {
    throw new PolicyError(`${what} escapes the workspace: ${resolved}`, { hint: `Only paths inside ${path.resolve(root)} are allowed.` });
  }
  return resolved;
}
