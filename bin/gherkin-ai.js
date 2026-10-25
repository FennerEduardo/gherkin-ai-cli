#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// npm checks "engines" only when installing (and only warns); an older Node would otherwise run the CLI
// and fail later in unclear ways. Exit 2 (usage) before loading anything.
const required = (require('../package.json').engines || {}).node || '';
const minimum = (required.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
const current = process.versions.node.split('.').map(Number);
const older = minimum.length === 3 && (current[0] - minimum[0] || current[1] - minimum[1] || current[2] - minimum[2]) < 0;
if (older) {
  console.error(`gherkin-ai requires Node.js ${required}; this is Node.js ${process.versions.node} (${process.execPath}).`);
  console.error('Install a newer Node.js (e.g. `nvm install 22`), or check which `node` your shell resolves first.');
  process.exit(2);
}

// Check if compiled dist directory exists
const distIndex = path.join(__dirname, '../dist/index.js');
const srcIndex = path.join(__dirname, '../src/index.ts');

let cli;
if (fs.existsSync(distIndex)) {
  cli = require(distIndex);
} else {
  try {
    require('ts-node/register');
    cli = require(srcIndex);
  } catch (err) {
    console.error('Error starting gherkin-ai CLI. Please build the project first using "npm run build".');
    console.error(err);
    process.exit(1);
  }
}

cli.main(process.argv);
