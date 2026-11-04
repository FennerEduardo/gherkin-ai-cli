/* ==========================================================================
   gherkin-ai-cli - Plugin integrity (PLAN-3.3.0-reverse-plus EC-04)

   `plugins.allow` says which plugins may load; integrity says which bytes.
   A plugin's integrity is a sha512 over its files (the package directory of
   an npm plugin, without node_modules; the file itself for a path plugin),
   in a stable order. The expected value comes from `plugins.integrity`
   (`{ "<specifier>": "sha512-…" }`, lockable by the organization) or from
   `.ghk/plugins.lock`, which `ghk plugin lock` writes. A plugin whose
   bytes differ is refused with exit 5 and audited; one without an
   expected value loads as before.
   ========================================================================== */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const LOCK_FILE = path.join('.ghk', 'plugins.lock');

export interface PluginLock {
  version: 1;
  plugins: Record<string, { resolved: string; version?: string; integrity: string }>;
}

function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** The directory of the npm package that contains `resolved`, or undefined for a plugin that is a single file. */
function packageDir(resolved: string, isPath: boolean): string | undefined {
  if (isPath) return undefined;
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** sha512 of a plugin's bytes: its package directory (without node_modules), or its single file. */
export function pluginIntegrity(resolved: string, isPath: boolean): string {
  const hash = crypto.createHash('sha512');
  const dir = packageDir(resolved, isPath);
  if (!dir) {
    hash.update(fs.readFileSync(resolved));
  } else {
    for (const f of filesOf(dir)) {
      hash.update(path.relative(dir, f).split(path.sep).join('/'));
      hash.update('\0');
      hash.update(fs.readFileSync(f));
      hash.update('\0');
    }
  }
  return `sha512-${hash.digest('base64')}`;
}

export function readPluginLock(root: string): PluginLock | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'));
    return data?.version === 1 && data.plugins ? data as PluginLock : undefined;
  } catch {
    return undefined;
  }
}

/** The expected integrity of a specifier: `plugins.integrity` first (the organization can lock it), then the lock file. */
export function expectedIntegrity(root: string, specifier: string, configured?: Record<string, string>): string | undefined {
  return configured?.[specifier] ?? readPluginLock(root)?.plugins[specifier]?.integrity;
}

/** Writes .ghk/plugins.lock for the given `plugins.load` entries as they are on disk now. */
export function writePluginLock(root: string, load: string[]): PluginLock {
  const lock: PluginLock = { version: 1, plugins: {} };
  for (const specifier of load) {
    const isPath = specifier.startsWith('.') || path.isAbsolute(specifier);
    const resolved = isPath ? path.resolve(root, specifier) : require.resolve(specifier, { paths: [root] });
    const dir = packageDir(resolved, isPath);
    let version: string | undefined;
    try { version = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version : undefined; } catch { version = undefined; }
    lock.plugins[specifier] = { resolved: path.relative(root, resolved).split(path.sep).join('/'), ...(version ? { version } : {}), integrity: pluginIntegrity(resolved, isPath) };
  }
  fs.mkdirSync(path.join(root, '.ghk'), { recursive: true });
  fs.writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
