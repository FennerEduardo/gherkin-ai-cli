import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildIR, buildIRFromFile, clearIRCache, getSourceFeature } from '../../src/core/ir-builder';

const FEATURE = 'Feature: Orders\n  Scenario: Place\n    When the customer creates an order\n    Then an "OrderCreated" event is published\n';
let dir: string | undefined;
afterEach(() => { clearIRCache(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('IR cache (4.8)', () => {
  it('reuses one build per feature, file and options, and returns independent copies', () => {
    const parsed = parseGherkinText(FEATURE);
    const a = buildIR(parsed, 'orders.feature');
    const b = buildIR(parsed, 'orders.feature');
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    a.commands.length = 0; // a caller mutating its copy does not change the cache
    expect(buildIR(parsed, 'orders.feature').commands.length).toBeGreaterThan(0);
    expect(buildIR(parsed, 'other.feature').sourceFile).toBe('other.feature');
  });

  it('keeps the verbatim source feature on cached copies (generators read the "And" steps from it)', () => {
    const parsed = parseGherkinText(FEATURE);
    buildIR(parsed, 'orders.feature');
    expect(getSourceFeature(buildIR(parsed, 'orders.feature'))).toBe(parsed);
    expect(JSON.stringify(buildIR(parsed, 'orders.feature'))).not.toContain('sourceFeature');

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-ir-cache-'));
    const file = path.join(dir, 'orders.feature');
    fs.writeFileSync(file, FEATURE);
    buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, path.join(dir, 'cache'));
    clearIRCache();
    const fromDisk = buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, path.join(dir, 'cache'));
    expect(getSourceFeature(fromDisk)?.scenarios[0].steps.map(s => s.text)).toEqual(['the customer creates an order', 'an "OrderCreated" event is published']);
  });

  it('caches file IRs on disk, keyed by the text, and ignores a corrupt entry', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-ir-cache-'));
    const file = path.join(dir, 'orders.feature');
    const cache = path.join(dir, 'cache');
    fs.writeFileSync(file, FEATURE);
    const first = buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, cache);
    const entries = fs.readdirSync(cache);
    expect(entries).toHaveLength(1);
    expect(buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, cache).featureName).toBe(first.featureName);

    fs.writeFileSync(file, FEATURE.replace('Orders', 'Invoices'));
    expect(buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, cache).featureName).toBe('Invoices');
    expect(fs.readdirSync(cache)).toHaveLength(2);

    for (const e of fs.readdirSync(cache)) fs.writeFileSync(path.join(cache, e), '{corrupt');
    expect(buildIRFromFile(file, 'orders.feature', { mode: 'deterministic' }, cache).featureName).toBe('Invoices');
  });

  it('never caches builds that read state outside the key', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-ir-cache-'));
    const file = path.join(dir, 'orders.feature');
    fs.writeFileSync(file, FEATURE);
    buildIRFromFile(file, 'orders.feature', { mode: 'deterministic', constitutionPath: 'x' }, path.join(dir, 'cache'));
    expect(fs.existsSync(path.join(dir, 'cache'))).toBe(false);
  });
});
