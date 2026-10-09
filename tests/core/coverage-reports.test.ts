import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseJacoco, parseCobertura, parseLcov, parseIstanbulSummary, findCoverage } from '../../src/core/coverage-reports';
import { findLayerDirs } from '../../src/core/arch-rules';

// Method → class → sourcefile → package → report. Only the last counters are the totals.
const JACOCO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<report name="orders">
  <sessioninfo id="x" start="1" dump="2"/>
  <package name="com/acme/orders/domain">
    <class name="com/acme/orders/domain/Order" sourcefilename="Order.java">
      <method name="place" desc="()V" line="10">
        <counter type="INSTRUCTION" missed="0" covered="5"/>
        <counter type="LINE" missed="0" covered="2"/>
        <counter type="METHOD" missed="0" covered="1"/>
      </method>
      <counter type="INSTRUCTION" missed="10" covered="5"/>
      <counter type="LINE" missed="3" covered="2"/>
    </class>
    <sourcefile name="Order.java">
      <counter type="LINE" missed="3" covered="2"/>
    </sourcefile>
    <counter type="LINE" missed="3" covered="2"/>
  </package>
  <counter type="INSTRUCTION" missed="10" covered="90"/>
  <counter type="BRANCH" missed="4" covered="16"/>
  <counter type="LINE" missed="8" covered="92"/>
  <counter type="METHOD" missed="1" covered="9"/>
</report>`;

describe('coverage report readers', () => {
  it('reads JaCoCo report-level totals, not the first method counters', () => {
    expect(parseJacoco(JACOCO)).toEqual({ lines: 92, branches: 80, functions: 90, statements: 90 });
  });

  it('reads Cobertura with attributes in any order', () => {
    const xml = '<?xml version="1.0"?><coverage branch-rate="0.5" version="1.9" line-rate="0.875" timestamp="1"></coverage>';
    expect(parseCobertura(xml)).toEqual({ lines: 88, branches: 50, functions: 88, statements: 88 });
  });

  it('sums lcov records', () => {
    const lcov = ['SF:a.ts', 'FNF:2', 'FNH:1', 'LF:10', 'LH:10', 'end_of_record', 'SF:b.ts', 'FNF:2', 'FNH:2', 'LF:10', 'LH:5', 'end_of_record'].join('\n');
    expect(parseLcov(lcov)).toEqual({ lines: 75, branches: 75, functions: 75, statements: 75 });
  });

  it('rejects a coverage-final.json style file (no total)', () => {
    expect(parseIstanbulSummary(JSON.stringify({ '/src/a.ts': { s: {} } }))).toBeNull();
  });

  describe('findCoverage', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-cov-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('skips an unrecognized report and keeps searching', () => {
      fs.mkdirSync(path.join(dir, 'coverage'));
      fs.writeFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), '{"not":"a summary"}');
      fs.mkdirSync(path.join(dir, 'target', 'site', 'jacoco'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'target', 'site', 'jacoco', 'jacoco.xml'), JACOCO);
      const found = findCoverage([dir]);
      expect(found?.totals.lines).toBe(92);
      expect(found?.skipped).toHaveLength(1);
    });

    it('returns null when there is no report', () => {
      expect(findCoverage([dir])).toBeNull();
    });
  });
});

describe('findLayerDirs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-layers-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('finds Maven package layers, .NET projects and aliases, ignoring build output', () => {
    for (const d of [
      'src/main/java/com/acme/orders/domain',
      'src/main/java/com/acme/orders/application',
      'src/main/java/com/acme/orders/adapters',
      'Orders.Api',
      'target/classes/com/acme/orders/presentation',
      'node_modules/x/domain'
    ]) fs.mkdirSync(path.join(dir, d), { recursive: true });

    expect(findLayerDirs([dir], 'domain')).toEqual(['src/main/java/com/acme/orders/domain']);
    expect(findLayerDirs([dir], 'infrastructure')).toEqual(['src/main/java/com/acme/orders/adapters']);
    expect(findLayerDirs([dir], 'presentation')).toEqual(['Orders.Api']);
  });
});

describe('ghk quality report parsing', () => {
  it('reads a multi-line JaCoCo CSV (CRLF too)', async () => {
    const { parseCoverageReport } = await import('../../src/core/coverage-integration');
    const csv = 'GROUP,PACKAGE,CLASS,INSTRUCTION_MISSED,INSTRUCTION_COVERED\r\napp,a,A,10,30\r\napp,b,B,0,60\r\n';
    expect(parseCoverageReport('JaCoCo', csv)).toBe(90);
  });

  it('reads the go tool cover total', async () => {
    const { parseCoverageReport } = await import('../../src/core/coverage-integration');
    const txt = 'acme/orders/order.go:10:\tPlace\t100.0%\ntotal:\t\t\t(statements)\t87.5%\n';
    expect(parseCoverageReport('go tool cover', txt)).toBe(87.5);
  });
});
