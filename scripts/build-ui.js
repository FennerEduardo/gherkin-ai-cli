#!/usr/bin/env node
/* ==========================================================================
   Builds the Web Studio static assets into dist/ui/public with no runtime CDN
   dependencies (corporate networks commonly block them):
   - compiles Tailwind from the classes used in index.html -> vendor/tailwind.css
   - copies Font Awesome CSS + webfonts -> vendor/fontawesome/
   ========================================================================== */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'ui', 'public');
const OUT = path.join(ROOT, 'dist', 'ui', 'public');
const VENDOR = path.join(OUT, 'vendor');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true });
fs.mkdirSync(VENDOR, { recursive: true });

execFileSync(process.execPath, [
  require.resolve('tailwindcss/lib/cli.js', { paths: [ROOT] }),
  '-i', path.join(ROOT, 'src', 'ui', 'tailwind.input.css'),
  '-o', path.join(VENDOR, 'tailwind.css'),
  '--content', path.join(SRC, '**', '*.html'),
  '--minify'
], { stdio: ['ignore', 'ignore', 'inherit'] });

const fa = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json', { paths: [ROOT] }));
fs.mkdirSync(path.join(VENDOR, 'fontawesome', 'css'), { recursive: true });
fs.copyFileSync(path.join(fa, 'css', 'all.min.css'), path.join(VENDOR, 'fontawesome', 'css', 'all.min.css'));
fs.cpSync(path.join(fa, 'webfonts'), path.join(VENDOR, 'fontawesome', 'webfonts'), { recursive: true });

console.log('Web Studio assets built in', path.relative(ROOT, OUT));
