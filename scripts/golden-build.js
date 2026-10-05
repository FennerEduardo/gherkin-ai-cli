#!/usr/bin/env node
/* ==========================================================================
   Golden builds: for every STABLE stack, generate a sample project with the
   built CLI, then compile it AND run its generated test suite inside the
   stack's official Docker image.

   Usage:  npm run build && node scripts/golden-build.js [stack ...] [--keep] [--list] [--no-integration]

   Backends also run their runtime integration tests (docs/RUNTIME-KERNEL.md)
   against PostgreSQL and RabbitMQ containers on a private network. The full
   log of each stack is written to <tmp>/ghk-golden-<stack>.log.

   A stack passes when the generated project builds and its tests exit 0
   (pending BDD steps are allowed; failing or erroring tests are not).
   Dependency caches are kept in named Docker volumes (ghk-cache-*).
   ========================================================================== */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STACKS } = require('./golden-stacks');
const { startServices } = require('./golden-services');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'gherkin-ai.js');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipIntegration = args.includes('--no-integration');
const selected = args.filter(a => !a.startsWith('--'));

if (args.includes('--list')) {
  for (const [name, s] of Object.entries(STACKS)) console.log(`${name.padEnd(16)} ${s.image}`);
  process.exit(0);
}

const FEATURE = fs.readFileSync(path.join(__dirname, 'golden-feature.feature'), 'utf8');

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function generate(name, def) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ghk-golden-${name}-`));
  fs.mkdirSync(path.join(dir, 'features'));
  fs.writeFileSync(path.join(dir, 'features', 'payment.feature'), FEATURE);
  fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({
    projectName: `golden-${name}`,
    architecture: 'hexagonal',
    stack: def.stack,
    ...(def.frontendStack ? { frontendStack: def.frontendStack } : {}),
    ...(def.config || {}),
    rules: {},
    outputDir: './'
  }, null, 2));
  const res = run(process.execPath, [CLI, 'generate', '-f', 'features/payment.feature', '--yes'], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1', GHK_NON_INTERACTIVE: 'true', GHK_TELEMETRY_DISABLED: 'true' }
  });
  if (res.code !== 0) throw new Error(`ghk generate failed for ${name}:\n${res.out}`);
  return dir;
}

function dockerPath(p) {
  // Docker Desktop on Windows accepts drive paths as-is; elsewhere use the POSIX path.
  return p;
}

/**
 * Builds and tests the project in the toolchain image. Stacks with `integration` commands
 * also run the runtime integration tests against PostgreSQL and RabbitMQ (golden-services.js).
 */
function buildInDocker(dir, def, name) {
  const volumes = (def.caches || []).flatMap(([vol, target]) => ['-v', `ghk-cache-${vol}:${target}`]);
  const integration = def.integration && !skipIntegration ? def.integration : [];
  const services = integration.length ? startServices(name) : undefined;
  // Only the integration step sees DATABASE_URL / AMQP_URL: unit tests stay hermetic.
  const exports = services ? Object.entries(services.env).map(([k, v]) => `export ${k}='${v}'`) : [];
  const script = [...(def.build || []), ...(def.test || []), ...exports, ...integration].join(' && ');
  try {
    const env = { ...(def.env || {}) };
    return run('docker', [
      'run', '--rm',
      ...(services ? ['--network', services.network] : []),
      '-v', `${dockerPath(dir)}:/work`, '-w', `/work${def.workdir ? `/${def.workdir}` : ''}`,
      ...volumes,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      def.image, 'sh', '-c', script
    ], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  } finally {
    if (services) services.stop();
  }
}

function summarize(log) {
  const lines = log.split('\n');
  const errors = lines.filter(l => /(error|ERROR|FAIL|Failed|failed|Exception|cannot find|undefined:|SyntaxError)/.test(l) && !/^\s*at /.test(l));
  return [...new Set(errors.map(l => l.trim()))].slice(0, 80);
}

let failed = 0;
const results = [];
for (const [name, def] of Object.entries(STACKS)) {
  if (selected.length && !selected.includes(name)) continue;
  process.stdout.write(`\n▶ ${name}: generating…\n`);
  let dir;
  const started = Date.now();
  try {
    dir = generate(name, def);
    process.stdout.write(`  building and testing in ${dir} (${def.image}${def.integration && !skipIntegration ? ' + PostgreSQL + RabbitMQ' : ''})\n`);
    const res = buildInDocker(dir, def, name);
    fs.writeFileSync(path.join(os.tmpdir(), `ghk-golden-${name}.log`), res.out);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (res.code === 0) {
      process.stdout.write(`  ✔ ${name} builds and tests pass (${secs}s)\n`);
      results.push([name, 'pass', secs]);
    } else {
      failed++;
      results.push([name, 'FAIL', secs]);
      process.stdout.write(`  ✖ ${name} failed (${secs}s)\n`);
      const errs = summarize(res.out);
      process.stdout.write((errs.length ? errs.join('\n') : res.out.slice(-6000)) + '\n');
      if (process.env.GHK_GOLDEN_VERBOSE) process.stdout.write(res.out.slice(-20000) + '\n');
    }
  } catch (err) {
    failed++;
    results.push([name, 'ERROR', '-']);
    process.stdout.write(`  ✖ ${err.message}\n`);
  } finally {
    if (dir && !keep) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Files written by the container as root may not be removable by the runner user; not a build failure.
      }
    }
  }
}

if (results.length > 1) {
  process.stdout.write('\nSummary\n');
  for (const [n, s, t] of results) process.stdout.write(`  ${s.padEnd(5)} ${n} (${t}s)\n`);
}
process.exit(failed ? 1 : 0);
