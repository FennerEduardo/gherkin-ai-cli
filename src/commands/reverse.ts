/* ==========================================================================
   gherkin-ai-cli - 'reverse' command (beta): from existing code to proposed features

   ghk reverse scan     [--path src] [--include g] [--exclude g] [--openapi f] [--no-tests] [--json]
   ghk reverse propose  [--scope Order] [--min-confidence strong] [--threshold 80] [--rescan] [--json]
   ghk reverse accept   <aggregate…> | --all  [--to features/discovered] [--merge] [--force] [--yes] [--json]
   ghk reverse coverage [--min <pct>] [--rescan] [--json]
   ghk reverse explain  <Command | "METHOD /path"> [--json]
   ghk reverse sync     [--all-features] [--rescan] [--json]
   ghk reverse review   [aggregate…] [--approve <sel>] [--reject <sel>] [--note t] [--interactive] [--context n] [--json]

   Deterministic: no LLM is called. scan and propose write only inside
   .ghe/reverse/; accept writes .feature files after confirmation (or
   --yes). None needs `ghk init`. Exit codes: 2 usage, 4 when a proposal
   scores below the lint threshold or loses a command in its round trip,
   7 when coverage is below --min or `accept --merge` finds commands a
   feature declares and the code does not implement. PLAN-3.3.0 §3.A;
   explain and review: PLAN-3.3.0-reverse-plus RV-01, RV-03; sync (exit 7 on drift,
   a patch per feature in .ghe/patches/, never an edit): RV-02.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { ExitCode, UsageError } from '../core/errors';
import { CONFIDENCE_ORDER, type EvidenceConfidence } from '../core/reverse/evidence';
import { REVERSE_DIR, readCandidates, readScan, readUnresolved, runAccept, runCoverage, runPropose, runScan, writeReverseFile, type ScanOptions, type ScanResult } from '../core/reverse';
import { REVIEW_FILE, applyDecisions, buildReviewReport, explainOperation, findOperation, readReview, type Decision } from '../core/reverse/review';
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
  /** propose: LLM wording as a patch (opt-in). */
  assist?: boolean;
  /** review */
  approve?: string[];
  reject?: string[];
  note?: string;
  interactive?: boolean;
  context?: string;
  /** accept: take every scenario even with a review on file. */
  ignoreReview?: boolean;
  /** sync: compare every feature, not only the accepted characterizations. */
  allFeatures?: boolean;
}

const SUBCOMMANDS = ['scan', 'propose', 'accept', 'coverage', 'explain', 'review', 'sync'];

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

/** The `reverse` section of gherkin-ai.config.json as defaults; flags on the command line win. */
function withConfigDefaults(root: string, options: ReverseCommandOptions): ReverseCommandOptions {
  let section: Record<string, any> | undefined;
  try {
    const file = path.join(root, 'gherkin-ai.config.json');
    if (fs.existsSync(file)) section = JSON.parse(fs.readFileSync(file, 'utf8'))?.reverse;
  } catch { /* an invalid configuration is reported by ghk validate */ }
  if (!section) return options;
  return {
    ...options,
    path: options.path ?? section.path,
    include: options.include ?? section.include,
    exclude: options.exclude ?? section.exclude,
    openapi: options.openapi ?? section.openapi,
    tests: options.tests === false ? false : section.tests ?? options.tests,
    minConfidence: options.minConfidence ?? section.minConfidence,
    threshold: options.threshold ?? (section.threshold !== undefined ? String(section.threshold) : undefined),
    to: options.to ?? section.acceptDir,
    min: options.min ?? (section.minCoverage !== undefined ? String(section.minCoverage) : undefined)
  };
}

/**
 * `propose --assist`: the configured LLM words each proposal (title, user story, scenario names). Validated,
 * written as a patch in .ghe/patches/; the proposal and its steps are never changed by the model.
 */
async function assistProposals(root: string, proposals: string[]) {
  const { LLMClient, resolveLLMSettings } = await import('../core/llm');
  const { proposeNarrative } = await import('../core/reverse/assist');
  const { writeProposal } = await import('../core/governance/agent-changes');
  const client = new LLMClient(resolveLLMSettings());
  const out: { proposal: string; patch?: string; accepted: unknown; rejected: { field: string; value: string; reason: string }[] }[] = [];
  for (const rel of proposals) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    const result = await proposeNarrative(client, text);
    const patch = result.featureText !== text ? path.relative(root, writeProposal(root, file, result.featureText)).split(path.sep).join('/') : undefined;
    out.push({ proposal: rel, patch, accepted: result.accepted, rejected: result.rejected });
  }
  return out;
}

export async function handleReverseCommand(subcommand: string | undefined, options: ReverseCommandOptions, names: string[] = []): Promise<void> {
  if (!subcommand || !SUBCOMMANDS.includes(subcommand)) {
    throw new UsageError(subcommand ? `Unknown reverse subcommand: ${subcommand}` : 'Missing reverse subcommand.', { hint: `Use one of: ${SUBCOMMANDS.join(', ')} (ghk reverse scan, then propose, then accept).` });
  }
  const root = process.cwd();
  options = withConfigDefaults(root, options);

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

  if (subcommand === 'sync') {
    const { buildCandidates } = await import('../core/reverse/candidates');
    const { runSync } = await import('../core/reverse/sync');
    const { writeProposal } = await import('../core/governance/agent-changes');
    // sync always reads the code as it is now.
    const scan = await runScan(root, { ...scanOptions(options), write: !options.dryRun });
    const { candidates } = buildCandidates(scan.evidence);
    const report = runSync(root, candidates, scan.evidence, {
      allFeatures: options.allFeatures,
      write: !options.dryRun,
      writePatch: (feature, content) => path.relative(root, writeProposal(root, path.join(root, feature), content)).split(path.sep).join('/')
    });
    if (report.drift) process.exitCode = ExitCode.DRIFT;
    if (options.json) { emitJson(report); return; }
    if (!report.features) {
      logger.warn('No accepted characterization feature (@reverse-engineered) to compare with.');
      console.log('  Accept proposals first: ghk reverse propose, review, accept.');
      return;
    }
    logger.info(`ghk reverse sync (beta): ${report.features} characterization feature(s) against the code`);
    for (const n of report.newOperations) console.log(`  + ${n.method} ${n.path}  ${n.operation}: new in ${n.aggregate}, not in ${n.feature}`);
    for (const m of report.missingOperations) console.log(`  - ${m.operation} in ${m.feature}: the code no longer has it`);
    for (const c of report.changed) {
      console.log(`  ~ ${c.operation} in ${c.feature}: behaviour changed`);
      for (const a of c.added) console.log(`      + ${a}`);
      for (const r of c.removed) console.log(`      - ${r}`);
    }
    for (const m of report.moved) console.log(`  > ${m.operation} / ${m.scenario}: evidence moved to ${m.after.join(', ')}`);
    for (const s of report.specOnly) console.log(`  ! ${s.command} in ${s.feature}: declared, not implemented`);
    if (report.uncovered) console.log(`  ${report.uncovered} operation(s) in aggregates no feature characterizes (ghk reverse coverage)`);
    if (report.patches.length) console.log(`  Patches to review: ${report.patches.join(', ')} (git apply <patch>)`);
    console.log(report.drift ? '  Drift between the code and the specifications: exit 7.' : '  The specifications match the code.');
    return;
  }

  if (subcommand === 'explain' || subcommand === 'review') {
    const { buildCandidates } = await import('../core/reverse/candidates');
    const scan = (!options.rescan && readScan(root)) || await runScan(root, scanOptions(options));
    const fromFile = !options.rescan ? readCandidates(root) : undefined;
    const built = fromFile ? undefined : buildCandidates(scan.evidence);
    const candidates = fromFile ?? built!.candidates;
    const unresolved = fromFile ? readUnresolved(root) : built!.unresolved;

    if (subcommand === 'explain') {
      const target = names.join(' ').trim();
      if (!target) throw new UsageError('Name the operation to explain.', { hint: 'ghk reverse explain PlaceOrder  |  ghk reverse explain "POST /orders/{id}/cancel"' });
      const hits = findOperation(candidates, target);
      if (!hits.length) throw new UsageError(`No operation matches: ${target}`, { hint: `Operations: ${candidates.map(c => c.operation.name).slice(0, 20).join(', ')}` });
      const explanations = hits.map(c => explainOperation(c, scan.evidence, unresolved));
      if (options.json) { emitJson({ status: 'beta', explanations }); return; }
      for (const x of explanations) {
        logger.info(`${x.operation} (${x.type}) — ${x.endpoint}, aggregate ${x.aggregate}`);
        console.log(`  Name:       ${x.name.origin}: ${x.name.detail}`);
        console.log(`  Aggregate:  ${x.aggregateOrigin.origin}: ${x.aggregateOrigin.detail}`);
        console.log(`  Confidence: ${x.confidence.level}: ${x.confidence.reason}`);
        console.log('  Evidence chain:');
        for (const l of x.chain) console.log(`    ${l.role.padEnd(11)} ${l.file}:${l.line}  ${l.description}  [${l.extractor}, ${l.confidence}] ${l.id}`);
        console.log(`  Scenarios: ${x.scenarios.map(s => `${s.name} (${s.category}, ${s.confidence})`).join('; ') || 'none'}`);
        for (const q of x.openQuestions) console.log(`  ? ${q}`);
      }
      return;
    }

    // review
    let review = readReview(root, REVERSE_DIR);
    const selectors: { decision: Decision; selector: string }[] = [
      ...(options.approve ?? []).map(selector => ({ decision: 'approve' as const, selector })),
      ...(options.reject ?? []).map(selector => ({ decision: 'reject' as const, selector }))
    ];
    const scoped = names.length ? candidates.filter(c => names.map(n => n.toLowerCase()).includes(c.aggregate.toLowerCase())) : candidates;
    if (names.length && !scoped.length) throw new UsageError(`No proposal matches: ${names.join(', ')}`, { hint: `Proposals: ${[...new Set(candidates.map(c => c.aggregate))].join(', ')}` });
    const save = (next: typeof review, changed: string[]) => {
      if (options.dryRun || !changed.length) return;
      writeReverseFile(root, REVIEW_FILE, `${JSON.stringify(next, null, 2)}\n`);
    };

    if (selectors.length) {
      const { review: next, changed, unmatched } = applyDecisions(review, scoped, selectors, options.note);
      if (unmatched.length && !changed.length) throw new UsageError(`No scenario matches: ${unmatched.join(', ')}`, { hint: 'Use a scenario name, @CommandName for every scenario of an operation, or all.' });
      save(next, changed);
      review = next;
      if (changed.length) {
        const { getTelemetry } = await import('../core/telemetry');
        getTelemetry().recordAudit({ action: 'reverse:review', status: 'SUCCESS', resource: changed.join(', '), details: selectors.map(s => `${s.decision} ${s.selector}`).join('; ') });
      }
      if (!options.json) {
        for (const k of changed) console.log(`  ${next.decisions[k].decision === 'approve' ? '✔' : '✖'} ${k}`);
        for (const u of unmatched) console.log(`  ? no scenario matches ${u}`);
      }
    } else if (options.interactive) {
      if (!process.stdin.isTTY || options.json) throw new UsageError('--interactive needs a terminal.', { hint: 'Without a terminal, decide with --approve and --reject.' });
      const inquirer = (await import('inquirer')).default;
      const report = buildReviewReport(root, scoped, scan.evidence, review, unresolved, { context: Number(options.context ?? 3) });
      const picks: { decision: Decision; selector: string }[] = [];
      outer: for (const p of report.proposals) for (const s of p.scenarios.filter(x => x.status === 'pending' || x.status === 'stale')) {
        console.log(`\n${p.aggregate} · ${s.operation} · ${s.name}  [${s.confidence}${s.status === 'stale' ? ', code changed since the last review' : ''}]`);
        for (const st of s.steps) {
          console.log(`  ${st.keyword} ${st.text}`);
          for (const e of st.evidence) for (const [i, line] of (e.excerpt?.lines ?? []).entries()) console.log(`      ${String((e.excerpt!.from + i)).padStart(5)} │ ${line}`);
        }
        const { choice } = await inquirer.prompt([{ type: 'list', name: 'choice', message: 'Decision', choices: ['approve', 'reject', 'skip', 'quit'] }]);
        if (choice === 'quit') break outer;
        if (choice !== 'skip') picks.push({ decision: choice as Decision, selector: s.name });
      }
      const { review: next, changed } = applyDecisions(review, scoped, picks);
      save(next, changed);
      review = next;
    }

    const report = buildReviewReport(root, scoped, scan.evidence, review, unresolved, { context: Number(options.context ?? 3), excerpts: !selectors.length });
    if (options.json) { emitJson({ status: 'beta', ...report }); return; }
    if (!selectors.length) {
      for (const p of report.proposals) {
        logger.info(`${p.aggregate}`);
        for (const s of p.scenarios) {
          const mark = { approved: '✔', rejected: '✖', stale: '!', pending: '·' }[s.status];
          console.log(`  ${mark} ${s.name}  @${s.operation} [${s.confidence}]${s.status === 'stale' ? ' (code changed since the last review)' : ''}${s.note ? `  note: ${s.note}` : ''}`);
          for (const st of s.steps) {
            console.log(`      ${st.keyword} ${st.text}`);
            for (const e of st.evidence) {
              console.log(`        ${e.file}:${e.line}`);
              for (const [i, line] of (e.excerpt?.lines ?? []).entries()) console.log(`        ${String(e.excerpt!.from + i).padStart(5)} │ ${line}`);
            }
          }
        }
      }
      for (const q of report.openQuestions) console.log(`  ? ${q.question}`);
    }
    const c = report.counts;
    console.log(`  ${c.approved} approved, ${c.rejected} rejected, ${c.stale} stale, ${c.pending} pending. ghk reverse accept takes the approved scenarios.`);
    return;
  }

  if (subcommand === 'accept') {
    if (!names.length && !options.all) throw new UsageError('Name the proposals to accept, or pass --all.', { hint: 'ghk reverse accept order invoice  |  ghk reverse accept --all' });
    const scan = readScan(root);
    const candidates = readCandidates(root);
    if (!scan || !candidates) throw new UsageError('There are no proposals to accept.', { hint: 'Run ghk reverse propose first and review .ghe/reverse/proposals/.' });
    const plan = runAccept(root, scan, candidates, { names, all: options.all, to: options.to, merge: options.merge, force: options.force, minConfidence: minConfidence(options), ignoreReview: options.ignoreReview, write: false });
    if (!plan.matched) throw new UsageError(`No proposal matches: ${names.join(', ')}`, { hint: `Proposals: ${[...new Set(candidates.map(c => c.aggregate))].join(', ')}` });
    let result = plan;
    if (plan.written.length && !options.dryRun && await confirmWrite(plan.written.map(w => w.file), options)) {
      result = runAccept(root, scan, candidates, { names, all: options.all, to: options.to, merge: options.merge, force: options.force, minConfidence: minConfidence(options), ignoreReview: options.ignoreReview, write: true });
      const { getTelemetry } = await import('../core/telemetry');
      getTelemetry().recordAudit({ action: 'reverse:accept', status: 'SUCCESS', resource: result.written.map(w => w.file).join(', '), details: options.merge ? 'merge' : 'all scenarios' });
    } else if (plan.written.length) {
      result = { ...plan, written: [] , skipped: [...plan.skipped, ...plan.written.map(w => ({ file: w.file, reason: options.dryRun ? 'dry run' : 'not confirmed' }))] };
    }
    if (result.drift) process.exitCode = ExitCode.DRIFT;
    if (options.json) { emitJson(result); return; }
    if (!result.written.length && !result.skipped.length) console.log('  Nothing to accept: the features already specify every selected operation.');
    for (const w of result.written) console.log(`  ✔ ${w.file}  ${w.scenarios} scenario(s)`);
    for (const s of result.skipped) console.log(`  – ${s.file}: ${s.reason}`);
    if (result.notApproved?.length) console.log(`  ${result.notApproved.length} scenario(s) left out by the review (${[...new Set(result.notApproved.map(n => n.status))].join(", ")}); --ignore-review takes them all`);
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

  const assisted = options.assist && !options.dryRun ? await assistProposals(root, result.proposals.map(p => p.path)) : undefined;
  if (options.json) { emitJson(assisted ? { ...result, assist: assisted } : result); return; }
  for (const a of assisted ?? []) {
    console.log(`  ✎ ${a.proposal}: ${a.patch ? `wording proposed in ${a.patch}` : 'no valid wording'}${a.rejected.length ? ` (${a.rejected.length} value(s) rejected)` : ''}`);
  }
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
  for (const c of result.conflicts) console.log(`  ! ${c.message}`);
  if (result.conflicts.length) console.log(`  ${result.conflicts.length} contradiction(s) between tests and code in ${path.join('.ghe', 'reverse', 'conflicts.json')}; those operations are inferred until someone decides`);
  console.log('  These are candidate specifications: they describe what the code does today and need human review.');
}
