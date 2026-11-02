/* ==========================================================================
   gherkin-ai-cli - `ghk reverse` pipeline (PLAN-3.3.0 §3.A)

   scan:    discovery → analyzers → Source Evidence IR → .ghe/reverse/scan.json
   propose: evidence → behaviour candidates → proposals (.feature, re-parsed
            and linted) → .ghe/reverse/{candidates.json,
            unresolved-questions.json, proposals/*.feature}

   Both only ever write inside .ghe/reverse/ (which ignores itself in git),
   and two runs on the same tree produce byte-identical files.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { CLI_VERSION } from '../../version';
import { detectExistingStack } from '../stack-detector';
import { discoverSources, type DiscoveryOptions } from './discovery';
import { dedupeEvidence, type EvidenceConfidence, type SourceEvidence } from './evidence';
import { loadBuiltinAnalyzers, type AnalysisContext, type AnalyzerMaturity } from './registry';
import { buildCandidates, type BehaviorCandidate, type UnresolvedQuestion } from './candidates';
import { renderProposals, type RenderedProposal } from './renderer';

export const REVERSE_DIR = path.join('.ghe', 'reverse');

export interface ScanOptions extends DiscoveryOptions {
  openapi?: string[];
  includeTests?: boolean;
  /** Restrict to these analyzer ids. */
  analyzers?: string[];
  /** false: nothing is written (`--dry-run`, round-trip measurements on repositories that must stay untouched). */
  write?: boolean;
}

export interface ScanResult {
  ghkVersion: string;
  status: 'beta';
  root: string;
  stack: { language?: string; framework?: string };
  files: number;
  truncated: boolean;
  secretsSkipped: number;
  analyzers: { id: string; maturity: AnalyzerMaturity; evidence: number }[];
  counts: Record<string, number>;
  evidence: SourceEvidence[];
}

export interface ProposeOptions {
  minConfidence?: EvidenceConfidence;
  threshold?: number;
  /** Only the aggregates (or operation names) given, case-insensitive. */
  scope?: string[];
  /** false: nothing is written (`--dry-run`). */
  write?: boolean;
}

export interface ProposeResult {
  ghkVersion: string;
  status: 'beta';
  proposals: (Omit<RenderedProposal, 'text'> & { path: string })[];
  candidates: BehaviorCandidate[];
  unresolved: UnresolvedQuestion[];
  /** Lint threshold the proposals were measured against. */
  threshold: number;
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

/** Writes inside .ghe/reverse/ only; the directory ignores itself so `git status` stays clean. */
export function writeReverseFile(root: string, relative: string, content: string): string {
  const dir = path.join(root, REVERSE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  }
  const target = path.join(dir, relative);
  if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) throw new Error(`Refusing to write outside ${REVERSE_DIR}: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const stableJson = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

export async function runScan(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const discovery = discoverSources(root, options);
  const detected = detectExistingStack(root);
  const ctx: AnalysisContext = {
    root,
    files: discovery.files,
    stack: detected.stack,
    openapi: options.openapi?.map(p => rel(root, path.resolve(root, p))),
    includeTests: options.includeTests ?? true
  };
  const all = await loadBuiltinAnalyzers();
  const selected = all.filter(a => (!options.analyzers?.length || options.analyzers.includes(a.id)) && a.detect(ctx));
  const perAnalyzer: ScanResult['analyzers'] = [];
  let evidence: SourceEvidence[] = [];
  for (const a of selected) {
    const found = await a.analyze(ctx);
    perAnalyzer.push({ id: a.id, maturity: a.maturity, evidence: found.length });
    evidence.push(...found);
  }
  evidence = dedupeEvidence(evidence);
  const counts: Record<string, number> = {};
  for (const e of evidence) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const result: ScanResult = {
    ghkVersion: CLI_VERSION,
    status: 'beta',
    root: '.',
    stack: { language: detected.stack?.language, framework: detected.stack?.framework },
    files: discovery.files.length,
    truncated: discovery.truncated,
    secretsSkipped: discovery.secretsSkipped,
    analyzers: perAnalyzer,
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    evidence
  };
  if (options.write !== false) writeReverseFile(root, 'scan.json', stableJson(result));
  return result;
}

export function readScan(root: string): ScanResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, REVERSE_DIR, 'scan.json'), 'utf8')) as ScanResult;
  } catch {
    return undefined;
  }
}

export function runPropose(root: string, scan: ScanResult, options: ProposeOptions = {}): ProposeResult {
  const { candidates: all, unresolved } = buildCandidates(scan.evidence);
  const scope = (options.scope ?? []).map(s => s.toLowerCase());
  const candidates = scope.length ? all.filter(c => scope.includes(c.aggregate.toLowerCase()) || scope.includes(c.operation.name.toLowerCase())) : all;
  const threshold = options.threshold ?? 80;
  const rendered = renderProposals(candidates, scan.evidence, { minConfidence: options.minConfidence, threshold });

  if (options.write !== false) {
    // Proposals of an earlier run that no longer exist are removed, so the directory mirrors this run.
    const proposalsDir = path.join(root, REVERSE_DIR, 'proposals');
    if (fs.existsSync(proposalsDir)) {
      const keep = new Set(rendered.map(p => p.file));
      for (const f of fs.readdirSync(proposalsDir)) if (f.endsWith('.feature') && !keep.has(f)) fs.rmSync(path.join(proposalsDir, f));
    }
    for (const p of rendered) writeReverseFile(root, path.join('proposals', p.file), p.text);
    writeReverseFile(root, 'candidates.json', stableJson(candidates));
    writeReverseFile(root, 'unresolved-questions.json', stableJson(unresolved));
  }

  return {
    ghkVersion: CLI_VERSION,
    status: 'beta',
    proposals: rendered.map(({ text: _text, ...p }) => ({ ...p, path: `${REVERSE_DIR.split(path.sep).join('/')}/proposals/${p.file}` })),
    candidates,
    unresolved,
    threshold
  };
}
