/* ==========================================================================
   gherkin-ai-cli - Line coverage as evidence (`reverse scan --coverage`,
   PLAN-3.3.0-reverse-plus RV-15)

   Reads the report a test run already wrote (nothing is executed):
   - lcov (`SF:` / `DA:<line>,<hits>`), from c8, nyc, Jest, Vitest, pytest-cov
     with `--cov-report=lcov`, go-test-coverage converters;
   - JaCoCo XML (`<sourcefile name>` / `<line nr ci>` under its package);
   - Cobertura XML (`<class filename>` / `<line number hits>`), from
     coverage.py, coverlet and gcovr.
   A line that ran proves nothing about the outcome on its own. Evidence is
   raised to `confirmed` only when its line ran AND a test calls the endpoint
   it belongs to: the test exercised that path and the code under it.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { SourceEvidence } from './evidence';
import { pathMatchesTemplate } from './analyzers/shared/body-text';

/** Executed lines per file, files as written in the report (forward slashes). */
export type LineCoverage = Map<string, Set<number>>;

const addLine = (cov: LineCoverage, file: string, line: number) => {
  const f = file.replace(/\\/g, '/');
  if (!cov.has(f)) cov.set(f, new Set());
  cov.get(f)!.add(line);
};

export function parseLcov(text: string, cov: LineCoverage = new Map()): LineCoverage {
  let file: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) file = line.slice(3);
    else if (line === 'end_of_record') file = undefined;
    else if (file && line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',');
      if (Number(hits) > 0) addLine(cov, file, Number(n));
    }
  }
  return cov;
}

export function parseJacoco(text: string, cov: LineCoverage = new Map()): LineCoverage {
  for (const pkg of text.matchAll(/<package\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g)) {
    for (const sf of pkg[2].matchAll(/<sourcefile\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/sourcefile>/g)) {
      const file = `${pkg[1] ? `${pkg[1]}/` : ''}${sf[1]}`;
      for (const l of sf[2].matchAll(/<line\s+nr="(\d+)"[^>]*\bci="(\d+)"/g)) if (Number(l[2]) > 0) addLine(cov, file, Number(l[1]));
    }
  }
  return cov;
}

export function parseCobertura(text: string, cov: LineCoverage = new Map()): LineCoverage {
  for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    for (const l of cls[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) if (Number(l[2]) > 0) addLine(cov, cls[1], Number(l[1]));
  }
  return cov;
}

/** Reads one report, choosing the format by its content. */
export function readCoverageReport(file: string, cov: LineCoverage = new Map()): { format: 'lcov' | 'jacoco' | 'cobertura'; coverage: LineCoverage } {
  const text = fs.readFileSync(file, 'utf8');
  if (/^\s*(TN:|SF:)/m.test(text)) return { format: 'lcov', coverage: parseLcov(text, cov) };
  if (/<report\b[\s\S]*<sourcefile\b/.test(text)) return { format: 'jacoco', coverage: parseJacoco(text, cov) };
  if (/<coverage\b[\s\S]*<class\b/.test(text)) return { format: 'cobertura', coverage: parseCobertura(text, cov) };
  throw new Error(`${path.basename(file)} is not an lcov, JaCoCo or Cobertura report`);
}

/**
 * The executed lines of an evidence file. Reports name files absolute, relative to the project, relative to a
 * source root (`src/main/java/`) or by package (`com/shop/OrderController.java`): the longest suffix match wins.
 */
export function executedLines(cov: LineCoverage, rel: string): Set<number> | undefined {
  const want = rel.replace(/\\/g, '/');
  let best: { len: number; lines: Set<number> } | undefined;
  for (const [file, lines] of cov) {
    const f = file.replace(/^\.\//, '');
    if (want === f || want.endsWith(`/${f}`) || f.endsWith(`/${want}`)) {
      const len = Math.min(f.length, want.length);
      if (!best || len > best.len) best = { len, lines };
    }
  }
  return best?.lines;
}

/**
 * Raises to `confirmed` the evidence whose line ran and whose endpoint a test calls; returns how many items rose.
 * Evidence is changed in place and keeps `metadata.executed = true` as the reason.
 */
export function applyLineCoverage(evidence: SourceEvidence[], cov: LineCoverage): number {
  const tests = evidence.filter(e => e.kind === 'test-case');
  const tested = new Set(evidence.filter(e => e.kind === 'http-endpoint').filter(ep => {
    const m = ep.metadata as any;
    return tests.some(t => (t.metadata as any)?.method === m?.method && pathMatchesTemplate(String(m?.path ?? ''), String((t.metadata as any)?.path ?? '')));
  }).map(e => e.id));
  let raised = 0;
  for (const e of evidence) {
    if (e.confidence === 'confirmed' || e.kind === 'test-case' || e.kind === 'http-endpoint') continue;
    if (!e.references.some(r => tested.has(r))) continue;
    const lines = executedLines(cov, e.location.file);
    if (!lines) continue;
    let ran = false;
    for (let l = e.location.startLine; l <= e.location.endLine && !ran; l++) ran = lines.has(l);
    if (!ran) continue;
    e.confidence = 'confirmed';
    e.metadata = { ...(e.metadata ?? {}), executed: true };
    raised++;
  }
  return raised;
}
