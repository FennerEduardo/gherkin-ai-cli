#!/usr/bin/env node
/* ==========================================================================
   Golden builds: for every STABLE stack, generate a sample project with the
   built CLI, then compile it AND run its generated test suite inside the
   stack's official Docker image.

   Usage:  npm run build && node scripts/golden-build.js [stack ...] [--keep] [--list] [--no-integration] [--no-image]

   Backends also run their runtime integration tests (docs/RUNTIME-KERNEL.md)
   against PostgreSQL and RabbitMQ containers on a private network. Backends
   with a generated Dockerfile also build their production image, start it on
   that network and must answer their liveness and readiness probes. The full
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
// The same PostgreSQL / RabbitMQ harness as `ghk verify --services` (src/core/services.ts, built into dist/).
const { startServices } = require('../dist/core/services');
const { resolveAppRuntimeEnv, resolveHealth } = require('../dist/generators/toolchains');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'gherkin-ai.js');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipIntegration = args.includes('--no-integration');
const skipImage = args.includes('--no-image');
const selected = args.filter(a => !a.startsWith('--'));

if (args.includes('--list')) {
  for (const [name, s] of Object.entries(STACKS)) console.log(`${name.padEnd(16)} ${s.image}`);
  process.exit(0);
}

const FEATURE = fs.readFileSync(path.join(__dirname, 'golden-feature.feature'), 'utf8');
const SECOND_FEATURE = fs.readFileSync(path.join(__dirname, 'golden-feature-refund.feature'), 'utf8');

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
  // Backends and frontends are generated as a two-feature service: the second generate must keep the
  // first feature (contracts, routes, runtime command service registry, frontend entry) and both are
  // built and tested.
  const twoFeatures = def.integration || def.frontendStack || def.stack.framework === 'flutter';
  const features = twoFeatures ? ['payment', 'refund'] : ['payment'];
  if (features.includes('refund')) fs.writeFileSync(path.join(dir, 'features', 'refund.feature'), SECOND_FEATURE);
  for (const feature of features) {
    const res = run(process.execPath, [CLI, 'generate', '-f', `features/${feature}.feature`, '--yes'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', GHK_NON_INTERACTIVE: 'true', GHK_TELEMETRY_DISABLED: 'true' }
    });
    if (res.code !== 0) throw new Error(`ghk generate failed for ${name} (${feature}):\n${res.out}`);
  }
  return dir;
}

function dockerPath(p) {
  // Docker Desktop on Windows accepts drive paths as-is; elsewhere use the POSIX path.
  return p;
}

/**
 * Builds and tests the project in the toolchain image. Stacks with `integration` commands
 * also run the runtime integration tests against PostgreSQL and RabbitMQ (src/core/services.ts).
 */
function buildInDocker(dir, def, name) {
  const volumes = (def.caches || []).flatMap(([vol, target]) => ['-v', `ghk-cache-${vol}:${target}`]);
  const integration = def.integration && !skipIntegration ? def.integration : [];
  const services = integration.length ? startServices(name, def.services || []) : undefined;
  // Only the integration step sees DATABASE_URL / AMQP_URL: unit tests stay hermetic.
  const exports = services ? Object.entries(services.env).map(([k, v]) => `export ${k}='${v}'`) : [];
  const script = [...(def.build || []), ...(def.test || []), ...exports, ...integration].join(' && ');
  try {
    const env = { ...(def.env || {}) };
    const res = run('docker', [
      'run', '--rm',
      ...(services ? ['--network', services.network] : []),
      '-v', `${dockerPath(dir)}:/work`, '-w', `/work${def.workdir ? `/${def.workdir}` : ''}`,
      ...volumes,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // Tool images (terraform, helm) set the tool as entrypoint: run the shell instead.
      ...(def.entrypoint ? ['--entrypoint', def.entrypoint, def.image] : [def.image, 'sh']), '-c', script
    ], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (res.code !== 0 || !services || skipImage || !fs.existsSync(path.join(dir, 'Dockerfile'))) return res;
    const image = smokeImage(dir, def, name, services);
    return { code: image.code, out: `${res.out}\n--- production image ---\n${image.out}` };
  } finally {
    if (services) services.stop();
  }
}

// Platform-provided settings the production images expect (secret managers in a real deployment).
const IMAGE_ENV = {
  JWT_SECRET: 'golden-image-secret-with-32-chars!!',
  SECRET_KEY_BASE: 'golden'.repeat(16),
  APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'),
  DJANGO_SECRET_KEY: 'golden-django-secret'
};

/**
 * Builds the generated Dockerfile, starts the image on the services network and waits until its liveness
 * and readiness probes answer 200 (toolchains.ts resolveHealth).
 */
function smokeImage(dir, def, name, services) {
  const tag = `ghk-golden-${name}:image`;
  const container = `ghk-app-${name}-${Date.now()}`;
  const opts = { env: { ...process.env, MSYS_NO_PATHCONV: '1' } };
  const log = [];
  const build = run('docker', ['build', '-q', '-t', tag, dockerPath(dir)], opts);
  log.push(build.out);
  if (build.code !== 0) return { code: build.code, out: `docker build failed\n${log.join('\n')}` };
  try {
    const { port } = resolveAppRuntimeEnv({ stack: def.stack });
    const health = resolveHealth({ stack: def.stack });
    const env = { ...IMAGE_ENV, ...services.env };
    const start = run('docker', ['run', '-d', '--name', container, '--network', services.network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), tag], opts);
    if (start.code !== 0) return { code: start.code, out: `docker run failed\n${start.out}` };
    const probe = p => run('docker', ['run', '--rm', '--network', services.network, 'curlimages/curl:8.11.1',
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `http://${container}:${port}${p}`], opts).out.trim();
    const deadline = Date.now() + 180_000;
    let codes = [];
    while (Date.now() < deadline) {
      codes = [health.live, health.ready].map(p => `${p}=${probe(p)}`);
      if (codes.every(c => c.endsWith('=200'))) {
        return { code: 0, out: `image ${tag} healthy on :${port} (${codes.join(', ')})` };
      }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
    }
    const logs = run('docker', ['logs', '--tail', '80', container], opts).out;
    return { code: 1, out: `image ${tag} did not become healthy on :${port} (${codes.join(', ')})\n--- container logs ---\n${logs}` };
  } finally {
    run('docker', ['rm', '-f', container], opts);
    run('docker', ['rmi', '-f', tag], opts);
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
      // In CI the temp log file is gone with the runner: print the end of the build output too.
      if (process.env.GHK_GOLDEN_VERBOSE || process.env.CI) process.stdout.write(`--- last lines of the build output ---\n${res.out.split('\n').slice(-150).join('\n')}\n`);
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
