/* ==========================================================================
   gherkin-ai-cli - Coverage report readers (Istanbul/c8 summary, lcov,
   JaCoCo XML, Cobertura XML). Each returns report-level totals in percent,
   or null when the file is not in that format.
   ========================================================================== */

import fs from 'fs';
import path from 'path';

export interface CoverageTotals {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

const pct = (covered: number, total: number) => (total > 0 ? Math.round((covered / total) * 100) : NaN);

/** Fills metrics a report does not have (NaN) with the line coverage, which every format provides. */
function complete(t: CoverageTotals): CoverageTotals | null {
  if (Number.isNaN(t.lines)) return null;
  const or = (v: number) => (Number.isNaN(v) ? t.lines : v);
  return { lines: t.lines, branches: or(t.branches), functions: or(t.functions), statements: or(t.statements) };
}

/** Istanbul/c8/vitest `coverage-summary.json`. */
export function parseIstanbulSummary(raw: string): CoverageTotals | null {
  try {
    const total = JSON.parse(raw)?.total;
    if (!total?.lines || typeof total.lines.pct !== 'number') return null;
    const get = (k: string) => (typeof total[k]?.pct === 'number' ? Math.round(total[k].pct) : NaN);
    return complete({ lines: get('lines'), branches: get('branches'), functions: get('functions'), statements: get('statements') });
  } catch {
    return null;
  }
}

/**
 * JaCoCo XML. Counters appear at every level (method, class, sourcefile, package, report); the report
 * totals are the counters that are direct children of <report>, i.e. after the last </package> or </group>.
 */
export function parseJacoco(raw: string): CoverageTotals | null {
  if (!/<report\b/.test(raw)) return null;
  const end = Math.max(raw.lastIndexOf('</package>'), raw.lastIndexOf('</group>'));
  const tail = end >= 0 ? raw.slice(end) : raw;
  const counters = new Map<string, { missed: number; covered: number }>();
  for (const m of tail.matchAll(/<counter\s+type="([A-Z]+)"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g)) {
    if (!counters.has(m[1])) counters.set(m[1], { missed: Number(m[2]), covered: Number(m[3]) });
  }
  const of = (type: string) => {
    const c = counters.get(type);
    return c ? pct(c.covered, c.missed + c.covered) : NaN;
  };
  return complete({ lines: of('LINE'), branches: of('BRANCH'), functions: of('METHOD'), statements: of('INSTRUCTION') });
}

/** Cobertura XML (coverlet, coverage.py): `line-rate` / `branch-rate` on <coverage>, in any attribute order. */
export function parseCobertura(raw: string): CoverageTotals | null {
  const tag = raw.match(/<coverage\b[^>]*>/)?.[0];
  if (!tag) return null;
  const attr = (name: string) => {
    const v = tag.match(new RegExp(`\\b${name}="([0-9.]+)"`))?.[1];
    return v === undefined ? NaN : Math.round(parseFloat(v) * 100);
  };
  return complete({ lines: attr('line-rate'), branches: attr('branch-rate'), functions: NaN, statements: NaN });
}

/** lcov tracefile: sums LF/LH, BRF/BRH and FNF/FNH over all records. */
export function parseLcov(raw: string): CoverageTotals | null {
  const sums: Record<string, number> = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
  let records = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(LF|LH|BRF|BRH|FNF|FNH):(\d+)/);
    if (m) sums[m[1]] += Number(m[2]);
    if (line.startsWith('end_of_record')) records++;
  }
  if (records === 0) return null;
  return complete({ lines: pct(sums.LH, sums.LF), branches: pct(sums.BRH, sums.BRF), functions: pct(sums.FNH, sums.FNF), statements: NaN });
}

/** Report locations tried in order under each root (project root and outputDir). */
export const COVERAGE_REPORT_PATHS = [
  'coverage/coverage-summary.json',
  '.nyc_output/coverage-summary.json',
  'coverage/lcov.info',
  'lcov.info',
  'target/site/jacoco/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
  'coverage/jacoco.xml',
  'coverage.cobertura.xml',
  'coverage/coverage.cobertura.xml',
  'coverage.xml',
  'TestResults/coverage.cobertura.xml'
];

function parserFor(file: string): (raw: string) => CoverageTotals | null {
  if (file.endsWith('.json')) return parseIstanbulSummary;
  if (file.endsWith('.info')) return parseLcov;
  return raw => (/<report\b/.test(raw) ? parseJacoco(raw) : parseCobertura(raw));
}

/**
 * The first report that exists AND parses. An unrecognized file does not stop the search
 * (e.g. a detailed coverage-final.json next to a JaCoCo report).
 */
export function findCoverage(roots: string[]): { totals: CoverageTotals; file: string; skipped: string[] } | null {
  const skipped: string[] = [];
  for (const root of [...new Set(roots)]) {
    for (const rel of COVERAGE_REPORT_PATHS) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      let totals: CoverageTotals | null = null;
      try {
        totals = parserFor(file)(fs.readFileSync(file, 'utf8'));
      } catch {
        totals = null;
      }
      if (totals) return { totals, file, skipped };
      skipped.push(file);
    }
  }
  return null;
}
