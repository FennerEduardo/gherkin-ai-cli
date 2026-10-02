#!/usr/bin/env node
/* ==========================================================================
   Golden builds: generate a sample project for every STABLE stack with the
   built CLI and prove the generated code compiles.

   Usage:  npm run build && node scripts/golden-build.js [nestjs] [dotnet] [--keep]

   - nestjs: installs real dependencies in a harness and runs `tsc --noEmit`.
   - dotnet: runs `dotnet build` (local SDK, or the mcr.microsoft.com/dotnet/sdk
     image through Docker when no SDK is installed).
   Exit code is non-zero when any stack fails.
   ========================================================================== */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'gherkin-ai.js');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const selected = args.filter(a => !a.startsWith('--'));

const FEATURE = `Feature: Payment Processing
  As a customer
  I want to pay my order
  So that the order is confirmed

  Scenario: Successful card payment
    Given an order with amount 100
    When the customer pays with a valid card
    Then the payment is approved
    And a PaymentApproved event is published

  Scenario: Declined card
    Given an order with amount 250
    When the customer pays with an expired card
    Then the payment is rejected with HTTP 422
`;

const STACKS = {
  nestjs: {
    stack: { language: 'typescript', framework: 'nestjs', orm: 'prisma', database: 'postgresql', validation: 'zod', auth: 'jwt', messaging: 'rabbitmq', testing: 'jest' },
    build: buildNest
  },
  dotnet: {
    stack: { language: 'csharp', framework: 'dotnet-aspnetcore', orm: 'efcore', database: 'postgresql', validation: 'fluentvalidation', auth: 'jwt', messaging: 'rabbitmq', testing: 'xunit' },
    build: buildDotnet
  }
};

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe', shell: process.platform === 'win32', ...opts });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function has(cmd) {
  return run(cmd, ['--version']).code === 0;
}

function generate(name, stack) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ghk-golden-${name}-`));
  fs.mkdirSync(path.join(dir, 'features'));
  fs.writeFileSync(path.join(dir, 'features', 'payment.feature'), FEATURE);
  fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ projectName: `golden-${name}`, architecture: 'hexagonal', stack, rules: {}, outputDir: './' }, null, 2));
  const res = run(process.execPath, [CLI, 'generate', '-f', 'features/payment.feature', '--yes'], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1', GHK_NON_INTERACTIVE: 'true', GHK_TELEMETRY_DISABLED: 'true' }
  });
  if (res.code !== 0) throw new Error(`ghk generate failed for ${name}:\n${res.out}`);
  return dir;
}

function buildNest(dir) {
  // Install exactly what the generated package.json declares: missing dependencies are a generator bug.
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir });
  if (install.code !== 0) return { ok: false, log: install.out };
  const prismaGenerate = run(process.execPath, [path.join(dir, 'node_modules', 'prisma', 'build', 'index.js'), 'generate', '--schema', 'prisma/schema.prisma'], { cwd: dir });
  if (prismaGenerate.code !== 0) return { ok: false, log: prismaGenerate.out };
  if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2021', module: 'commonjs', moduleResolution: 'node', strict: true,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
      skipLibCheck: true, noEmit: true, types: ['node', 'jest']
    },
    include: ['src/**/*.ts', 'test/**/*.ts', 'contracts.ts', 'fixtures.ts']
  }, null, 2));
  const tsc = run(process.execPath, [path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: dir });
  return { ok: tsc.code === 0, log: tsc.out };
}

function buildDotnet(dir) {
  const csproj = fs.readdirSync(dir).find(f => f.endsWith('.csproj'));
  if (!csproj) return { ok: false, log: 'No .csproj generated.' };
  if (has('dotnet')) {
    const res = run('dotnet', ['build', csproj, '-nologo', '-v', 'q'], { cwd: dir });
    return { ok: res.code === 0, log: res.out };
  }
  if (!has('docker')) return { ok: false, log: 'Neither the .NET SDK nor Docker is available.' };
  const image = process.env.GHK_DOTNET_IMAGE || 'mcr.microsoft.com/dotnet/sdk:9.0';
  const res = run('docker', ['run', '--rm', '-v', `${dir}:/src`, '-v', 'ghk-nuget-cache:/root/.nuget/packages', '-w', '/src', image, 'dotnet', 'build', csproj, '-nologo', '-v', 'q'], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' }
  });
  return { ok: res.code === 0, log: res.out };
}

function summarize(log) {
  const errors = log.split('\n').filter(l => /error (TS|CS|NU)\d+/.test(l)).map(l => l.replace(/\s+\[.*\]$/, '').trim());
  return [...new Set(errors)];
}

let failed = 0;
for (const [name, def] of Object.entries(STACKS)) {
  if (selected.length && !selected.includes(name)) continue;
  process.stdout.write(`\n▶ ${name}: generating…\n`);
  let dir;
  try {
    dir = generate(name, def.stack);
    process.stdout.write(`  building in ${dir}\n`);
    const result = def.build(dir);
    if (result.ok) {
      process.stdout.write(`  ✔ ${name} compiles\n`);
    } else {
      failed++;
      const errors = summarize(result.log);
      process.stdout.write(`  ✖ ${name} failed (${errors.length} distinct errors)\n`);
      process.stdout.write((errors.length ? errors.slice(0, 60).join('\n') : result.log.slice(-4000)) + '\n');
    }
  } catch (err) {
    failed++;
    process.stdout.write(`  ✖ ${err.message}\n`);
  } finally {
    if (dir && !keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
