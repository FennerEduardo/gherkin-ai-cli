#!/usr/bin/env node
/* ==========================================================================
   Builds the Web Studio static assets into dist/ui/public with no runtime CDN
   dependencies (corporate networks commonly block them):
   - compiles Tailwind 4 from the classes used in index.html -> vendor/tailwind.css
   - copies Font Awesome CSS + webfonts -> vendor/fontawesome/
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'ui', 'public');
const OUT = path.join(ROOT, 'dist', 'ui', 'public');
const VENDOR = path.join(OUT, 'vendor');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
fs.mkdirSync(VENDOR, { recursive: true });

async function buildTailwind() {
  // Tailwind 4 compiler API (no CLI): the CLI pulls a file watcher we do not need for a one-shot build.
  const { compile, optimize } = require('@tailwindcss/node');
  const { Scanner } = require('@tailwindcss/oxide');
  const input = path.join(ROOT, 'src', 'ui', 'tailwind.input.css');
  const base = path.dirname(input);
  const compiler = await compile(fs.readFileSync(input, 'utf8'), { base, onDependency: () => {} });
  const sources = compiler.sources.map(s => ({ base: s.base, pattern: s.pattern, negated: s.negated }));
  const candidates = new Scanner({ sources }).scan();
  const optimized = optimize(compiler.build(candidates), { minify: true });
  fs.writeFileSync(path.join(VENDOR, 'tailwind.css'), typeof optimized === 'string' ? optimized : optimized.code);
}

const fa = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json', { paths: [ROOT] }));
fs.mkdirSync(path.join(VENDOR, 'fontawesome', 'css'), { recursive: true });
fs.copyFileSync(path.join(fa, 'css', 'all.min.css'), path.join(VENDOR, 'fontawesome', 'css', 'all.min.css'));
fs.cpSync(path.join(fa, 'webfonts'), path.join(VENDOR, 'fontawesome', 'webfonts'), { recursive: true });

buildTailwind().then(
  () => console.log('Web Studio assets built in', path.relative(ROOT, OUT)),
  err => { console.error(err); process.exit(1); }
);
