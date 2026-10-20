#!/usr/bin/env node
/* ==========================================================================
   Golden builds: for every STABLE stack, generate a sample project with the
   built CLI, then compile it AND run its generated test suite inside the
   stack's official Docker image.

   Usage:  npm run build && node scripts/golden-build.js [stack ...] [--keep] [--list] [--no-integration] [--no-image] [--db-tls]

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
// --db-tls: PostgreSQL accepts TLS only and DATABASE_URL carries sslmode=require (managed databases enforce it).
const dbTls = args.includes('--db-tls');
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
  const services = integration.length ? startServices(name, def.services || [], { postgresTls: dbTls }) : undefined;
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

/** OpenTelemetry collector the production image exports to (debug exporter: spans are printed to its log). */
const COLLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.163.1';
const COLLECTOR_CONFIG = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
`;

const sleep = ms => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);

/** HS256 JWT with the tenant claim the generated application layer requires (kernel/app/shared.ts). */
function signJwt(claims, secret) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${require('crypto').createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** The command route of the golden service's first feature: POST /api/v1/<feature>/{id}/{command}. */
function commandPath(name) {
  const { parseGherkinText } = require('../dist/core/gherkin-parser');
  const { buildDomainModel } = require('../dist/generators/kernel/domain-model');
  const m = buildDomainModel(parseGherkinText(FEATURE), { service: `golden-${name}` });
  return `/api/v1/${m.kebab}/smoke-1/${m.commands[0].snake}`;
}

/**
 * Builds the generated Dockerfile, starts the image on the services network next to an OpenTelemetry collector,
 * waits until its liveness and readiness probes answer 200 (toolchains.ts resolveHealth), then runs one command
 * with a JWT and requires the collector to receive the service's spans (OTEL_EXPORTER_OTLP_ENDPOINT export).
 */
function smokeImage(dir, def, name, services) {
  const tag = `ghk-golden-${name}:image`;
  const stamp = Date.now();
  const container = `ghk-app-${name}-${stamp}`;
  const collector = `ghk-otel-${name}-${stamp}`;
  const serviceName = `golden-${name}`;
  const opts = { env: { ...process.env, MSYS_NO_PATHCONV: '1' } };
  const log = [];
  const build = run('docker', ['build', '-q', '-t', tag, dockerPath(dir)], opts);
  log.push(build.out);
  if (build.code !== 0) return { code: build.code, out: `docker build failed\n${log.join('\n')}` };
  const collectorConfig = path.join(os.tmpdir(), `ghk-otel-${name}-${stamp}.yaml`);
  fs.writeFileSync(collectorConfig, COLLECTOR_CONFIG);
  try {
    const otel = run('docker', ['run', '-d', '--name', collector, '--network', services.network,
      '-v', `${dockerPath(collectorConfig)}:/etc/otelcol/config.yaml:ro`, COLLECTOR_IMAGE, '--config=/etc/otelcol/config.yaml'], opts);
    if (otel.code !== 0) return { code: otel.code, out: `collector failed to start\n${otel.out}` };
    const { port } = resolveAppRuntimeEnv({ stack: def.stack });
    const health = resolveHealth({ stack: def.stack });
    const env = {
      ...IMAGE_ENV, ...services.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://${collector}:4318`, OTEL_SERVICE_NAME: serviceName, OTEL_BSP_SCHEDULE_DELAY: '500'
    };
    const start = run('docker', ['run', '-d', '--name', container, '--network', services.network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), tag], opts);
    if (start.code !== 0) return { code: start.code, out: `docker run failed\n${start.out}` };
    const curl = (...args) => run('docker', ['run', '--rm', '--network', services.network, 'curlimages/curl:8.11.1',
      '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', ...args], opts).out.trim();
    const deadline = Date.now() + 180_000;
    let codes = [];
    while (Date.now() < deadline) {
      codes = [health.live, health.ready].map(p => `${p}=${curl(`http://${container}:${port}${p}`)}`);
      if (codes.every(c => c.endsWith('=200'))) break;
      sleep(3000);
    }
    if (!codes.every(c => c.endsWith('=200'))) {
      const logs = run('docker', ['logs', '--tail', '80', container], opts).out;
      return { code: 1, out: `image ${tag} did not become healthy on :${port} (${codes.join(', ')})\n--- container logs ---\n${logs}` };
    }

    // One command through the HTTP API: its spans must reach the collector.
    const route = commandPath(name);
    const token = signJwt({ sub: 'golden', tenant_id: 'golden-tenant' }, IMAGE_ENV.JWT_SECRET);
    const response = run('docker', ['run', '--rm', '--network', services.network, 'curlimages/curl:8.11.1', '-s', '--max-time', '20',
      '-w', '\n%{http_code}', '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json',
      '-H', `Idempotency-Key: smoke-${stamp}`, '-d', '{}', `http://${container}:${port}${route}`], opts).out.trim();
    const status = response.slice(response.lastIndexOf('\n') + 1);
    if (status !== '202') {
      const logs = run('docker', ['logs', '--tail', '80', container], opts).out;
      return { code: 1, out: `image ${tag}: POST ${route} answered ${status}, expected 202\n--- response ---\n${response}\n--- container logs ---\n${logs}` };
    }
    const exportDeadline = Date.now() + 60_000;
    while (Date.now() < exportDeadline) {
      if (run('docker', ['logs', collector], opts).out.includes(serviceName)) {
        return { code: 0, out: `image ${tag} healthy on :${port} (${codes.join(', ')}); POST ${route} 202; spans of ${serviceName} received over OTLP` };
      }
      sleep(2000);
    }
    const logs = run('docker', ['logs', '--tail', '60', container], opts).out;
    return { code: 1, out: `image ${tag}: no span of ${serviceName} reached the OTLP collector within 60 s\n--- container logs ---\n${logs}` };
  } finally {
    run('docker', ['rm', '-f', container, collector], opts);
    run('docker', ['rmi', '-f', tag], opts);
    fs.rmSync(collectorConfig, { force: true });
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
