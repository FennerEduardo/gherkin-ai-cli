#!/usr/bin/env node
/* ==========================================================================
   Release preflight: checks a release candidate the way a fresh CI runner sees it.

   The candidate is checked out into a temporary git worktree (no dist/, no
   node_modules, nothing untracked), so problems that only appear on a clean
   machine show up before anything is pushed:
     - npm ci and the build;
     - the golden-builds matrix (golden-stacks.js must load and list stacks);
     - the committed config JSON Schema is the one the build generates;
     - the type check and npm audit --audit-level=high (release.yml blocks on it);
     - the tag, if given, matches package.json;
     - actionlint on the workflows (when Docker is available).

   Usage: node scripts/release-preflight.js [ref] [--tag vX.Y.Z]
   Exit code 0 only when every check passes.
   ========================================================================== */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const tagIndex = args.indexOf('--tag');
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
const ref = args.find((a, i) => !a.startsWith('--') && i !== tagIndex + 1) || 'HEAD';
const repo = path.resolve(__dirname, '..');
// npm 10.8 can crash resolving this tree ("edgesOut"); NPM=npx -y npm@11 selects another npm.
const npm = (process.env.NPM || 'npm').split(' ');

const run = (cmd, argv, cwd, opts = {}) => {
  const res = spawnSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', ...opts });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
};

const results = [];
const check = (name, fn) => {
  process.stdout.write(`  ${name} ... `);
  let ok;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok);
    detail = (r && r.detail) || '';
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  console.log(ok ? `ok${detail ? ` (${detail})` : ''}` : 'FAILED');
  if (!ok && detail) console.log(detail.trim().split('\n').slice(-20).map(l => `      ${l}`).join('\n'));
  results.push({ name, ok });
  return ok;
};

// ^{commit}: an annotated tag names its own object; the candidate is the commit it points to.
const sha = run('git', ['rev-parse', '--short', `${ref}^{commit}`], repo).out.trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-preflight-'));
console.log(`Release preflight of ${ref} (${sha}) in a clean worktree: ${dir}`);
const added = run('git', ['worktree', 'add', '--detach', dir, `${ref}^{commit}`], repo);
if (added.code !== 0) { console.error(added.out); process.exit(2); }

try {
  const installed = check('npm ci', () => {
    const r = run(npm[0], [...npm.slice(1), 'ci', '--no-audit', '--no-fund', '--loglevel=error'], dir);
    return { ok: r.code === 0, detail: r.code === 0 ? '' : r.out };
  });
  if (installed) {
    check('build', () => {
      const r = run(npm[0], [...npm.slice(1), 'run', 'build'], dir);
      return { ok: r.code === 0, detail: r.code === 0 ? '' : r.out };
    });
    check('golden-builds matrix', () => {
      const r = run('node', ['-p', "JSON.stringify(Object.keys(require('./scripts/golden-stacks').STACKS))"], dir);
      if (r.code !== 0) return { ok: false, detail: r.out };
      const stacks = JSON.parse(r.out.trim());
      return { ok: Array.isArray(stacks) && stacks.length > 0, detail: `${stacks.length} stacks` };
    });
    check('config JSON Schema up to date', () => {
      const r = run('git', ['diff', '--exit-code', '--', 'schemas/config.schema.json', 'schemas/industry-context.schema.json'], dir);
      return { ok: r.code === 0, detail: r.code === 0 ? '' : 'run npm run build and commit schemas/' };
    });
    check('type check', () => {
      const r = run('npx', ['tsc', '--noEmit', '--pretty', 'false'], dir);
      return { ok: r.code === 0, detail: r.code === 0 ? '' : r.out };
    });
    check('npm audit --audit-level=high', () => {
      const r = run(npm[0], [...npm.slice(1), 'audit', '--audit-level=high'], dir);
      return { ok: r.code === 0, detail: r.out.trim().split('\n').pop() };
    });
  }
  if (tag) {
    check(`tag ${tag} matches package.json`, () => {
      const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
      const tagged = run('git', ['rev-parse', '--short', `${tag}^{commit}`], repo).out.trim();
      return { ok: `v${version}` === tag && tagged === sha, detail: `package.json v${version}, ${tag} -> ${tagged || 'missing'}, candidate ${sha}` };
    });
  }
  if (run('docker', ['version', '--format', '{{.Server.Version}}'], dir).code === 0) {
    check('actionlint', () => {
      // Files are named explicitly: in a worktree .git is a file, so actionlint cannot find the repository itself.
      const workflows = fs.readdirSync(path.join(dir, '.github', 'workflows')).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`);
      const r = run('docker', ['run', '--rm', '-v', `${dir}:/repo`, '-w', '/repo', 'rhysd/actionlint:1.7.12', '-no-color', ...workflows], dir, { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      return { ok: r.code === 0, detail: r.code === 0 ? '' : r.out };
    });
  } else {
    console.log('  actionlint ... skipped (Docker is not available)');
  }
} finally {
  run('git', ['worktree', 'remove', '--force', dir], repo);
}

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed: ${failed.map(r => r.name).join(', ')}` : `\nAll ${results.length} checks passed for ${sha}.`);
process.exit(failed.length ? 1 : 0);
