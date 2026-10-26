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
     - release.yml's npm publish line, dry run, on the packed tarball;
     - the tag, if given, matches package.json;
     - actionlint on the workflows and the quick goldens (when Docker is available).

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
// Without --tag, tagIndex + 1 is 0: the ref in first position must not be taken for the tag's value.
const ref = args.find((a, i) => !a.startsWith('--') && (tagIndex < 0 || i !== tagIndex + 1)) || 'HEAD';
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
// mkdtemp makes the directory owner-only; the actionlint container reads it as another user.
fs.chmodSync(dir, 0o755);

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
    // release.yml's own publish line, on a tarball laid out as its download-artifact step leaves it (package/).
    // 3.2.1's first release failed here: npm took package/gherkin-ai-3.2.1.tgz for a GitHub repository.
    check('release.yml publishes the tarball (npm publish --dry-run)', () => {
      const line = fs.readFileSync(path.join(dir, '.github', 'workflows', 'release.yml'), 'utf8').match(/^\s*(npm publish .+)$/m);
      if (!line) return { ok: false, detail: 'no npm publish line in release.yml' };
      fs.mkdirSync(path.join(dir, 'package'));
      const packed = run(npm[0], [...npm.slice(1), 'pack', '--silent', '--pack-destination', 'package'], dir);
      if (packed.code !== 0) return { ok: false, detail: packed.out };
      const r = run('bash', ['-c', `TAG=latest; ${line[1]} --dry-run`], dir, { shell: false });
      return { ok: r.code === 0, detail: r.code === 0 ? '' : r.out };
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
    // The quick goldens use third-party images, some of them non-root (actionlint): they catch file
    // permission and runner differences that Docker Desktop on Windows or macOS hides. Run on Linux.
    if (installed) {
      check('quick goldens (CI pipelines, Helm)', () => {
        const quick = ['ci-github', 'ci-github-kubernetes', 'ci-gitlab', 'ci-azure-pipelines', 'helm'];
        const r = run('node', ['scripts/golden-build.js', ...quick], dir);
        return { ok: r.code === 0, detail: r.code === 0 ? `${quick.length} goldens${process.platform === 'linux' ? '' : '; run on Linux to match the CI runners'}` : r.out };
      });
    }
  } else {
    console.log('  actionlint and quick goldens ... skipped (Docker is not available)');
  }
} finally {
  run('git', ['worktree', 'remove', '--force', dir], repo);
}

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed: ${failed.map(r => r.name).join(', ')}` : `\nAll ${results.length} checks passed for ${sha}.`);
process.exit(failed.length ? 1 : 0);
