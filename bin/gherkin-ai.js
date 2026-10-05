#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

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
