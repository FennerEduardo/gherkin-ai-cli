/* ==========================================================================
   A second `ghk generate` changes nothing, the inventory included: it is
   versioned since 3.2.1, and every run used to rewrite each entry's date.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGenerateCommand } from '../../src/commands/generate';
import { resetRunContext } from '../../src/core/run-context';

describe('ghk generate twice', () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-idempotent-'));
    fs.mkdirSync(path.join(dir, 'features'));
    fs.writeFileSync(path.join(dir, 'features', 'orders.feature'), 'Feature: Orders\n  Scenario: Place\n    When the customer creates an order\n    Then the order is "PENDING"\n');
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({
      projectName: 'shop', architecture: 'hexagonal', outputDir: './', rules: {},
      stack: { language: 'typescript', framework: 'express', orm: 'none', database: 'postgresql', validation: 'zod', auth: 'jwt', testing: 'jest' }
    }));
    process.chdir(dir);
    resetRunContext();
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every inventory entry, dates included, when nothing changed', async () => {
    await handleGenerateCommand({ feature: 'features/orders.feature', yes: true });
    const first = fs.readFileSync(path.join(dir, '.ghe', 'inventory.json'), 'utf8');
    await new Promise(r => setTimeout(r, 20));
    const second = await handleGenerateCommand({ feature: 'features/orders.feature', yes: true });
    expect(second!.plan.every(p => p.action === 'unchanged')).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.ghe', 'inventory.json'), 'utf8')).toBe(first);
  });
});
