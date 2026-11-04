#!/usr/bin/env node
/* ==========================================================================
   Validation of the reverse analyzers on code gherkin-ai did not write
   (PLAN-3.3.0 §4.2): open-source implementations of the RealWorld (Conduit)
   API, whose specification fixes the expected endpoints
   (tests/fixtures/reverse/oss/realworld.json).

   For each repository, cloned at its pinned commit into a cache directory
   (never into this repository), it runs `reverse scan` and `reverse propose`
   in memory (nothing is written to the clone) and reports:
     - endpoint precision, recall and F1 against the specification (paths
       compared without the API prefix and with parameters normalised);
       infrastructure endpoints (health, ping, …) are left out, as the
       proposals leave them out;
     - the aggregates proposed and the lowest lint score of the proposals.
   An analyzer is beta at F1 >= 0.80 (PLAN-3.3.0 maturity table).

   Usage: npm run build && node scripts/reverse-oss.js [--cache <dir>] [--json out.json]
   Needs git and network access the first time (shallow fetch of one commit).
   ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'tests', 'fixtures', 'reverse', 'oss', 'realworld.json');
const BETA_F1 = 0.8;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The repository at exactly `commit`, fetched once into the cache. */
function checkout(cache, repo) {
  const dir = path.join(cache, path.basename(repo.repository));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', repo.repository);
  }
  if (spawnSync('git', ['cat-file', '-e', `${repo.commit}^{commit}`], { cwd: dir }).status !== 0) git(dir, 'fetch', '-q', '--depth', '1', 'origin', repo.commit);
  git(dir, 'checkout', '-q', '--force', repo.commit);
  return dir;
}

/** `GET /api/articles/{slug}` → `GET /articles/{}`: no API prefix, parameters normalised. */
function normalise(method, p) {
  const segments = p.split('/').filter(Boolean);
  while (segments.length && /^(api|v\d+)$/i.test(segments[0])) segments.shift();
  return `${method} /${segments.map(s => (/^\{.*\}$/.test(s) ? '{}' : s)).join('/')}`;
}

async function main() {
  const args = process.argv.slice(2);
  let cache = path.join(os.homedir(), '.cache', 'gherkin-ai', 'reverse-oss');
  let jsonOut;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache') cache = path.resolve(args[++i]);
    else if (args[i] === '--json') jsonOut = args[++i];
    else { console.error(`Unknown option: ${args[i]}`); process.exit(2); }
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const dist = path.join(ROOT, 'dist', 'core', 'reverse');
  const { runScan, runPropose } = require(dist);
  const { isInfrastructureEndpoint } = require(path.join(dist, 'candidates'));
  const expected = new Set(corpus.endpoints);

  // An entry may name a plugin (plugins/reverse-laravel): its analyzers join the built-in ones for that run.
  const { pluginRegistry } = require(path.join(ROOT, 'dist', 'core', 'plugin-system'));
  const loadedPlugins = new Set();

  const rows = [];
  for (const repo of corpus.repositories) {
    if (repo.plugin && !loadedPlugins.has(repo.plugin)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pluginRegistry.register(require(path.join(ROOT, repo.plugin)));
      loadedPlugins.add(repo.plugin);
    }
    const dir = checkout(cache, repo);
    const scan = await runScan(dir, { write: false });
    const found = new Set(scan.evidence
      .filter(e => e.kind === 'http-endpoint' && e.extractor === repo.analyzer && !isInfrastructureEndpoint(e.metadata.path))
      .map(e => normalise(e.metadata.method, e.metadata.path)));
    const hits = [...found].filter(e => expected.has(e)).length;
    const precision = found.size ? hits / found.size : 0;
    const recall = hits / expected.size;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const proposals = runPropose(dir, scan, { write: false });
    const lint = proposals.proposals?.map(p => p.lint?.score).filter(s => typeof s === 'number') ?? [];
    rows.push({
      analyzer: repo.analyzer,
      ...(repo.plugin ? { plugin: repo.plugin } : {}),
      repository: repo.repository,
      commit: repo.commit,
      expected: expected.size,
      found: found.size,
      matched: hits,
      precision: Number(precision.toFixed(2)),
      recall: Number(recall.toFixed(2)),
      f1: Number(f1.toFixed(2)),
      missing: corpus.endpoints.filter(e => !found.has(e)),
      unexpected: [...found].filter(e => !expected.has(e)).sort(),
      aggregates: [...new Set((proposals.candidates ?? []).map(c => c.aggregate).filter(Boolean))].sort(),
      lintMin: lint.length ? Math.min(...lint) : null,
      beta: f1 >= BETA_F1
    });
  }

  console.log(`${'analyzer'.padEnd(16)} ${'found'.padStart(5)} ${'matched'.padStart(8)} ${'P'.padStart(5)} ${'R'.padStart(5)} ${'F1'.padStart(5)}  lint-min  aggregates`);
  for (const r of rows) {
    console.log(`${r.analyzer.padEnd(16)} ${String(r.found).padStart(5)} ${`${r.matched}/${r.expected}`.padStart(8)} ${r.precision.toFixed(2).padStart(5)} ${r.recall.toFixed(2).padStart(5)} ${r.f1.toFixed(2).padStart(5)}  ${String(r.lintMin ?? '-').padStart(8)}  ${r.aggregates.join(', ')}`);
    if (r.missing.length) console.log(`  missing:    ${r.missing.join(', ')}`);
    if (r.unexpected.length) console.log(`  unexpected: ${r.unexpected.join(', ')}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ corpus: path.relative(ROOT, CORPUS), betaF1: BETA_F1, results: rows }, null, 2) + '\n');
  process.exit(rows.every(r => r.beta) ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
