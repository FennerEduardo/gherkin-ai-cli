/* ==========================================================================
   gherkin-ai-cli - 'reverse' command (beta): from existing code to proposed features

   ghk reverse scan     [--path src] [--include g] [--exclude g] [--openapi f] [--no-tests] [--json]
   ghk reverse propose  [--scope Order] [--min-confidence strong] [--threshold 80] [--rescan] [--json]
   ghk reverse accept   <aggregate…> | --all  [--to features/discovered] [--merge] [--force] [--yes] [--json]
   ghk reverse coverage [--min <pct>] [--rescan] [--json]

   Deterministic: no LLM is called. scan and propose write only inside
   .ghe/reverse/; accept writes .feature files after confirmation (or
   --yes). None needs `ghk init`. Exit codes: 2 usage, 4 when a proposal
   scores below the lint threshold or loses a command in its round trip,
   7 when coverage is below --min or `accept --merge` finds commands a
   feature declares and the code does not implement. PLAN-3.3.0 §3.A.
   ========================================================================== */

import path from 'path';
import { ExitCode, UsageError } from '../core/errors';
import { CONFIDENCE_ORDER, type EvidenceConfidence } from '../core/reverse/evidence';
import { readCandidates, readScan, runAccept, runCoverage, runPropose, runScan, type ScanOptions, type ScanResult } from '../core/reverse';
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
  /** Global --dry-run: analyse and report, write nothing (not even .ghe/reverse/). */
  dryRun?: boolean;
  /** accept */
  all?: boolean;
  to?: string;
  merge?: boolean;
  force?: boolean;
  yes?: boolean;
  /** coverage */
  min?: string;
}

const SUBCOMMANDS = ['scan', 'propose', 'accept', 'coverage'];

function scanOptions(o: ReverseCommandOptions): ScanOptions {
  return { path: o.path, include: o.include, exclude: o.exclude, openapi: o.openapi, includeTests: o.tests !== false, write: !o.dryRun };
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

function minConfidence(options: ReverseCommandOptions): EvidenceConfidence {
  const min = (options.minConfidence ?? 'inferred') as EvidenceConfidence;
  if (!CONFIDENCE_ORDER.includes(min) || min === 'unknown') throw new UsageError(`Invalid --min-confidence: ${options.minConfidence}`, { hint: 'Use confirmed, strong or inferred.' });
  return min;
}

function percent(value: string | undefined, flag: string, fallback: number): number {
  const n = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new UsageError(`Invalid ${flag}: ${value}`, { hint: 'A number between 0 and 100.' });
  return n;
}

async function confirmWrite(files: string[], options: ReverseCommandOptions): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || options.json) {
    throw new UsageError(`reverse accept would write ${files.length} file(s): ${files.join(', ')}. Nothing was written: pass --yes to confirm.`, { hint: 'Review the proposals in .ghe/reverse/proposals/ first.' });
  }
  const inquirer = (await import('inquirer')).default;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', default: false, message: `Write ${files.length} feature file(s)?\n  ${files.join('\n  ')}\n` }]);
  return Boolean(ok);
}

export async function handleReverseCommand(subcommand: string | undefined, options: ReverseCommandOptions, names: string[] = []): Promise<void> {
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(subcommand ? `Unknown reverse subcommand: ${subcommand}` : 'Missing reverse subcommand.', { hint: `Use one of: ${SUBCOMMANDS.join(', ')} (ghk reverse scan, then propose, then accept).` });
  }
  const root = process.cwd();

  if (subcommand === 'scan') {
    const scan = await runScan(root, scanOptions(options));
    if (options.json) { emitJson(scan); return; }
    printScan(scan);
    return;
  }

  if (subcommand === 'coverage') {
    const min = options.min === undefined ? undefined : percent(options.min, '--min', 0);
    const scan = (!options.rescan && readScan(root)) || await runScan(root, scanOptions(options));
    const report = runCoverage(root, scan);
    if (min !== undefined && report.coverage.percent < min) process.exitCode = ExitCode.DRIFT;
    if (options.json) { emitJson(report); return; }
    const c = report.coverage;
    logger.info(`ghk reverse coverage (beta): ${c.percent}% of the ${c.operations} operation(s) in the code are specified by ${report.features} feature(s)`);
    console.log(`  documented ${c.documented}, renamed ${c.renamed}, undocumented ${c.undocumented}`);
    for (const o of report.operations.filter(x => x.status !== 'documented')) {
      console.log(`  ${o.status === 'renamed' ? '~' : '+'} ${o.method} ${o.path}  ${o.operation}${o.status === 'renamed' ? ` (the feature ${o.feature} calls it ${o.specName})` : ''}`);
    }
    for (const s of report.specOnly) console.log(`  - ${s.command} in ${s.feature}: no operation in the code implements it`);
    if (min !== undefined && c.percent < min) console.log(`  Below --min ${min}%: exit 7.`);
    return;
  }

  if (subcommand === 'accept') {
    if (!names.length && !options.all) throw new UsageError('Name the proposals to accept, or pass --all.', { hint: 'ghk reverse accept order invoice  |  ghk reverse accept --all' });
    const scan = readScan(root);
    const candidates = readCandidates(root);
    if (!scan || !candidates) throw new UsageError('There are no proposals to accept.', { hint: 'Run ghk reverse propose first and review .ghe/reverse/proposals/.' });
    const plan = runAccept(root, scan, candidates, { names, all: options.all, to: options.to, merge: options.merge, force: options.force, minConfidence: minConfidence(options), write: false });
    if (!plan.written.length && !plan.skipped.length) throw new UsageError(`No proposal matches: ${names.join(', ')}`, { hint: `Proposals: ${[...new Set(candidates.map(c => c.aggregate))].join(', ')}` });
    let result = plan;
    if (plan.written.length && !options.dryRun && await confirmWrite(plan.written.map(w => w.file), options)) {
      result = runAccept(root, scan, candidates, { names, all: options.all, to: options.to, merge: options.merge, force: options.force, minConfidence: minConfidence(options), write: true });
      const { getTelemetry } = await import('../core/telemetry');
      getTelemetry().recordAudit({ action: 'reverse:accept', status: 'SUCCESS', resource: result.written.map(w => w.file).join(', '), details: options.merge ? 'merge' : 'all scenarios' });
    } else if (plan.written.length) {
      result = { ...plan, written: [] , skipped: [...plan.skipped, ...plan.written.map(w => ({ file: w.file, reason: options.dryRun ? 'dry run' : 'not confirmed' }))] };
    }
    if (result.drift) process.exitCode = ExitCode.DRIFT;
    if (options.json) { emitJson(result); return; }
    for (const w of result.written) console.log(`  ✔ ${w.file}  ${w.scenarios} scenario(s)`);
    for (const s of result.skipped) console.log(`  – ${s.file}: ${s.reason}`);
    for (const s of result.spec?.specOnly ?? []) console.log(`  ! ${s.command} in ${s.feature}: declared by the feature, not implemented by the code (exit 7)`);
    if (result.written.length) console.log('  Next: ghk lint --all, ghk graph, ghk converge --all');
    return;
  }

  const min = minConfidence(options);
  const threshold = percent(options.threshold, '--threshold', 80);
  const scan = (!options.rescan && !options.dryRun && readScan(root)) || await runScan(root, scanOptions(options));
  const result = runPropose(root, scan, { minConfidence: min, threshold, scope: options.scope, write: !options.dryRun });
  const failing = result.proposals.filter(p => !p.lint.passed || !p.roundTrip.ok);
  if (failing.length) process.exitCode = ExitCode.GATE_FAILED;

  if (options.json) { emitJson(result); return; }
  logger.info(`ghk reverse propose (beta): ${result.proposals.length} proposal(s) from ${result.candidates.length} operation(s)`);
  for (const p of result.proposals) {
    const mark = p.lint.passed && p.roundTrip.ok ? '✔' : '✖';
    console.log(`  ${mark} ${p.path}  ${p.scenarios} scenario(s), lint ${p.lint.score}/100, confidence ${p.confidence}${p.dropped ? `, ${p.dropped} below --min-confidence` : ''}${p.roundTrip.ok ? '' : `, round trip lost ${p.roundTrip.missingCommands.join(', ')}`}`);
  }
  if (result.spec.features) {
    const c = result.spec.coverage;
    console.log(`  Against the ${result.spec.features} existing feature(s): ${c.documented} documented, ${c.renamed} renamed, ${c.undocumented} undocumented (ghk reverse coverage for the list)`);
  }
  if (result.unresolved.length) console.log(`  ${result.unresolved.length} open question(s) in ${path.join('.ghe', 'reverse', 'unresolved-questions.json')}`);
  console.log('  These are candidate specifications: they describe what the code does today and need human review.');
}
