/* ==========================================================================
   gherkin-ai-cli - 'reverse' command (beta): from existing code to proposed features

   ghk reverse scan     [--path src] [--include g] [--exclude g] [--openapi f] [--no-tests] [--json]
   ghk reverse propose  [--scope Order] [--min-confidence strong] [--threshold 80] [--rescan] [--json]

   Deterministic: no LLM is called. Both subcommands write only inside
   .ghe/reverse/ and work without `ghk init`. Exit codes: 2 usage, 4 when a
   proposal scores below the lint threshold or its round trip loses a
   command. PLAN-3.3.0 §3.A.
   ========================================================================== */

import path from 'path';
import { ExitCode, UsageError } from '../core/errors';
import { CONFIDENCE_ORDER, type EvidenceConfidence } from '../core/reverse/evidence';
import { readScan, runPropose, runScan, type ScanOptions, type ScanResult } from '../core/reverse';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface ReverseCommandOptions {
  path?: string;
  include?: string[];
  exclude?: string[];
  openapi?: string[];
  tests?: boolean;
  scope?: string[];
  minConfidence?: string;
  threshold?: string;
  rescan?: boolean;
  json?: boolean;
}

const SUBCOMMANDS = ['scan', 'propose'];

function scanOptions(o: ReverseCommandOptions): ScanOptions {
  return { path: o.path, include: o.include, exclude: o.exclude, openapi: o.openapi, includeTests: o.tests !== false };
}

function printScan(scan: ScanResult): void {
  logger.info(`ghk reverse scan (beta): ${scan.files} files, stack ${scan.stack.language ?? '?'} + ${scan.stack.framework ?? '?'}`);
  if (!scan.analyzers.length) {
    logger.warn('No analyzer understands this code. Pass --openapi <file> to read an OpenAPI document instead.');
  }
  for (const a of scan.analyzers) console.log(`  ${a.id.padEnd(22)} ${a.maturity.padEnd(13)} ${a.evidence} evidence`);
  const counts = Object.entries(scan.counts).map(([k, v]) => `${k} ${v}`).join(', ');
  if (counts) console.log(`  ${counts}`);
  if (scan.secretsSkipped) console.log(`  ${scan.secretsSkipped} file(s) skipped because they may hold secrets`);
  console.log('  Evidence written to .ghe/reverse/scan.json. Next: ghk reverse propose');
}

export async function handleReverseCommand(subcommand: string | undefined, options: ReverseCommandOptions): Promise<void> {
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(subcommand ? `Unknown reverse subcommand: ${subcommand}` : 'Missing reverse subcommand.', { hint: `Use one of: ${SUBCOMMANDS.join(', ')} (ghk reverse scan, then ghk reverse propose).` });
  }
  const root = process.cwd();

  if (subcommand === 'scan') {
    const scan = await runScan(root, scanOptions(options));
    if (options.json) { emitJson(scan); return; }
    printScan(scan);
    return;
  }

  const min = (options.minConfidence ?? 'inferred') as EvidenceConfidence;
  if (!CONFIDENCE_ORDER.includes(min) || min === 'unknown') {
    throw new UsageError(`Invalid --min-confidence: ${options.minConfidence}`, { hint: 'Use confirmed, strong or inferred.' });
  }
  const threshold = options.threshold === undefined ? 80 : Number.parseInt(options.threshold, 10);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new UsageError(`Invalid --threshold: ${options.threshold}`, { hint: 'A score between 0 and 100.' });

  const scan = (!options.rescan && readScan(root)) || await runScan(root, scanOptions(options));
  const result = runPropose(root, scan, { minConfidence: min, threshold, scope: options.scope });
  const failing = result.proposals.filter(p => !p.lint.passed || !p.roundTrip.ok);
  if (failing.length) process.exitCode = ExitCode.GATE_FAILED;

  if (options.json) { emitJson(result); return; }
  logger.info(`ghk reverse propose (beta): ${result.proposals.length} proposal(s) from ${result.candidates.length} operation(s)`);
  for (const p of result.proposals) {
    const mark = p.lint.passed && p.roundTrip.ok ? '✔' : '✖';
    console.log(`  ${mark} ${p.path}  ${p.scenarios} scenario(s), lint ${p.lint.score}/100, confidence ${p.confidence}${p.dropped ? `, ${p.dropped} below --min-confidence` : ''}${p.roundTrip.ok ? '' : `, round trip lost ${p.roundTrip.missingCommands.join(', ')}`}`);
  }
  if (result.unresolved.length) console.log(`  ${result.unresolved.length} open question(s) in ${path.join('.ghe', 'reverse', 'unresolved-questions.json')}`);
  console.log('  These are candidate specifications: they describe what the code does today and need human review.');
}
