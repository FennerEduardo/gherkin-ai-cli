/* Test-only Web Studio launcher for Playwright.
   Serves a disposable copy of the fixture workspace with a known session token.
   The CLI itself never accepts a caller-chosen token. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const port = Number(process.env.GHK_E2E_PORT || 3001);
const token = process.env.GHK_E2E_TOKEN;
if (!token) throw new Error('GHK_E2E_TOKEN is required');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-e2e-'));
fs.cpSync(path.join(__dirname, 'fixtures', 'workspace'), workspace, { recursive: true });
process.chdir(workspace);

const { createWebApp } = require('../../dist/ui/server');
createWebApp(port, token).listen(port, '127.0.0.1', () => {
  console.log(`e2e Web Studio on http://127.0.0.1:${port} serving ${workspace}`);
});
