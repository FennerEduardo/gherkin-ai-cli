/* ==========================================================================
   gherkin-ai-cli - `ghk upgrade`: assisted project upgrade

   1. Analyse (read-only, the default): generated-file versions, config,
      CI scripts, MCP client configs, legacy files; optionally the CLI itself.
   2. Apply (--apply, or confirmed interactively): on a new git branch, fix
      the config, regenerate every feature, delete stale generated files that
      were never edited, and optionally commit. Nothing is pushed.
   ========================================================================== */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadResolvedConfig } from '../core/config';
import { ExitCode, GhkError, UsageError } from '../core/errors';
import { getRunContext, isNonInteractive } from '../core/run-context';
import { getTelemetry } from '../core/telemetry';
import {
  UpgradeFinding,
  checkProjectConfig,
  compareVersions,
  detectGeneratedVersion,
  findStaleFiles,
  generatedFindings,
  readInventory,
  scanAutomation,
  scanLegacyFiles,
  scanMcpConfigs
} from '../core/upgrade';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';
import { CLI_NAME, CLI_VERSION } from '../version';

export interface UpgradeOptions {
  config?: string;
  apply?: boolean;
  /** Exit with code 4 when required changes are pending (for CI). */
  check?: boolean;
  branch?: string;
  /** --no-git: apply in the working tree without creating a branch. */
  git?: boolean;
  commit?: boolean;
  /** Also delete stale files that cannot be proven unedited (header or git-tracked in outputDir only). */
  prune?: boolean;
  /** --no-regenerate */
  regenerate?: boolean;
  /** Also check the npm registry for a newer CLI. */
  cli?: boolean;
  /** Allow a dirty working tree. */
  force?: boolean;
  json?: boolean;
  yes?: boolean;
}

export interface UpgradeApplied {
  branch?: string;
  baseBranch?: string;
  configUpdated: boolean;
  regenerated: string[];
  removed: string[];
  kept: string[];
  changedFiles: string[];
  commit?: string;
}

export interface UpgradeReport {
  ok: boolean;
  from?: string;
  to: string;
  projectConfig: string | null;
  outputDir: string;
  features: string[];
  findings: UpgradeFinding[];
  summary: { required: number; recommended: number; info: number; auto: number; manual: number };
  applied: UpgradeApplied | null;
  nextSteps: string[];
}

const posix = (p: string) => p.split(path.sep).join('/');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

function listFeatures(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.feature')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

function latestPublishedVersion(): string | undefined {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return execFileSync(npm, ['view', CLI_NAME, 'version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, shell: process.platform === 'win32' }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

function summarize(findings: UpgradeFinding[]): UpgradeReport['summary'] {
  const count = (pred: (f: UpgradeFinding) => boolean) => findings.filter(pred).length;
  return {
    required: count(f => f.severity === 'required'),
    recommended: count(f => f.severity === 'recommended'),
    info: count(f => f.severity === 'info'),
    auto: count(f => f.fix === 'auto'),
    manual: count(f => f.fix === 'manual' && f.severity !== 'info')
  };
}

/** Removes now-empty directories between `file` and `root`. */
function pruneEmptyDirs(file: string, root: string): void {
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// ---------------------------------------------------------------------------

export async function analyzeProject(options: UpgradeOptions, cwd = process.cwd()) {
  const findings: UpgradeFinding[] = [];
  const configPath = path.resolve(cwd, options.config || 'gherkin-ai.config.json');
  const configRel = posix(path.relative(cwd, configPath));
  let raw: unknown;
  let fixedConfig: Record<string, unknown> | undefined;

  if (!fs.existsSync(configPath)) {
    findings.push({ id: 'config.missing', area: 'config', severity: 'required', fix: 'manual', file: configRel, message: 'No gherkin-ai.config.json found.', hint: 'Run `ghk init` (or `ghk detect`) to create one, then run `ghk upgrade` again.' });
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const check = checkProjectConfig(raw, configRel);
      findings.push(...check.findings);
      fixedConfig = check.fixed;
    } catch (err) {
      findings.push({ id: 'config.parse', area: 'config', severity: 'required', fix: 'manual', file: configRel, message: `gherkin-ai.config.json is not valid JSON: ${(err as Error).message}` });
    }
  }

  // Effective outputDir / specDir (fall back to the raw file when another layer is invalid).
  let outputDir = typeof (raw as any)?.outputDir === 'string' ? (raw as any).outputDir : './generated-specs';
  let specDir = typeof (raw as any)?.specDir === 'string' ? (raw as any).specDir : undefined;
  try {
    const resolved = loadResolvedConfig({ configPath: options.config, cwd });
    outputDir = resolved.config.outputDir || outputDir;
    specDir = resolved.config.specDir ?? specDir;
    for (const warning of resolved.warnings) findings.push({ id: 'config.layer-warning', area: 'config', severity: 'info', fix: 'none', message: warning });
  } catch (err) {
    if (raw !== undefined && !findings.some(f => f.id.startsWith('config.invalid'))) {
      findings.push({ id: 'config.layers', area: 'config', severity: 'required', fix: 'manual', message: (err as Error).message, hint: 'An organization, user or environment layer is invalid: run `ghk config validate`.' });
    }
  }
  const outputAbs = path.resolve(cwd, outputDir);

  const generated = detectGeneratedVersion(outputAbs);
  findings.push(...generatedFindings(generated, CLI_VERSION, outputDir));

  let features: string[] = [];
  try {
    const { resolveSpecDir } = await import('../utils/spec-dir-resolver');
    features = listFeatures(resolveSpecDir(specDir, cwd)).map(f => posix(path.relative(cwd, f)));
  } catch {
    // reported below
  }
  if (!features.length) {
    findings.push({ id: 'features.none', area: 'generated', severity: 'recommended', fix: 'manual', message: 'No .feature files found, so nothing can be regenerated.', hint: 'Set specDir in the config or keep features in ./features.' });
  }

  findings.push(...scanAutomation(cwd), ...scanMcpConfigs(cwd, CLI_VERSION), ...scanLegacyFiles(cwd));

  if (options.cli) {
    const latest = latestPublishedVersion();
    if (!latest) {
      findings.push({ id: 'cli.registry-unreachable', area: 'cli', severity: 'info', fix: 'none', message: `Could not query the npm registry for ${CLI_NAME}.`, hint: 'Check the npm proxy/registry settings (`npm config get registry`).' });
    } else if (compareVersions(latest, CLI_VERSION) > 0) {
      findings.push({ id: 'cli.update', area: 'cli', severity: 'recommended', fix: 'manual', message: `${CLI_NAME} v${latest} is available (running v${CLI_VERSION}).`, hint: `npm install -g ${CLI_NAME}@${latest}, then run \`ghk upgrade\` again.` });
    } else {
      findings.push({ id: 'cli.current', area: 'cli', severity: 'info', fix: 'none', message: `${CLI_NAME} v${CLI_VERSION} is the latest published version.` });
    }
  }

  return { findings, configPath, configRel, raw, fixedConfig, outputDir, outputAbs, generated, features };
}

type Analysis = Awaited<ReturnType<typeof analyzeProject>>;

async function applyUpgrade(analysis: Analysis, options: UpgradeOptions, cwd: string): Promise<UpgradeApplied> {
  const applied: UpgradeApplied = { configUpdated: false, regenerated: [], removed: [], kept: [], changedFiles: [] };
  const useGit = options.git !== false;

  if (useGit) {
    if (tryGit(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') {
      throw new UsageError('Not a git repository: the upgrade is applied on a new branch so it can be reviewed.', { hint: 'Run `git init` first, or pass --no-git to change the working tree directly.' });
    }
    const dirty = tryGit(['status', '--porcelain'], cwd);
    if (dirty && !options.force) {
      throw new UsageError('The working tree has uncommitted changes.', { hint: 'Commit or stash them first (or pass --force to carry them onto the upgrade branch).' });
    }
    applied.baseBranch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd) ?? undefined;
    const branch = options.branch || `ghk-upgrade-v${CLI_VERSION}`;
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd)) {
      throw new UsageError(`Branch "${branch}" already exists.`, { hint: 'Delete it, or choose another name with --branch <name>.' });
    }
    git(['checkout', '-q', '-b', branch], cwd);
    applied.branch = branch;
    logger.info(`Created branch ${branch}${applied.baseBranch ? ` from ${applied.baseBranch}` : ''}.`);
  }

  if (analysis.fixedConfig) {
    fs.writeFileSync(analysis.configPath, JSON.stringify(analysis.fixedConfig, null, 2) + '\n');
    applied.configUpdated = true;
    logger.success(`Updated ${analysis.configRel}.`);
  }

  const configBlocked = analysis.findings.some(f => f.area === 'config' && f.severity === 'required');
  if (options.regenerate !== false && analysis.features.length && configBlocked) {
    logger.warn('Skipping regeneration: fix the configuration errors listed above first.');
  } else if (options.regenerate !== false && analysis.features.length) {
    const previousInventory = readInventory(cwd);
    const generated = new Set<string>();
    const { handleGenerateCommand } = await import('./generate');
    for (const feature of analysis.features) {
      logger.info(`Regenerating from ${feature} ...`);
      await handleGenerateCommand({ feature, config: options.config, yes: true });
      for (const entry of readInventory(cwd)) generated.add(entry.filePath.replace(/\\/g, '/'));
      applied.regenerated.push(feature);
    }

    // In a dedicated output directory, every tracked file is a candidate (2.x wrote few headers).
    // Never in the project root, where it would sweep up hand-written code.
    const dedicated = path.relative(cwd, analysis.outputAbs) !== '' && useGit;
    const trackedFiles = dedicated
      ? (tryGit(['ls-files', '-z', '--', posix(path.relative(cwd, analysis.outputAbs))], cwd) ?? '')
        .split('\0').filter(Boolean).map(f => posix(path.relative(analysis.outputAbs, path.join(cwd, f))))
      : [];
    const stale = findStaleFiles({
      outputDir: analysis.outputAbs,
      generated,
      previousInventory,
      headerFiles: analysis.generated.files,
      trackedFiles,
      prune: options.prune
    });
    for (const rel of stale.removable) {
      const full = path.join(analysis.outputAbs, rel);
      fs.rmSync(full, { force: true });
      pruneEmptyDirs(full, analysis.outputAbs);
    }
    applied.removed = stale.removable;
    applied.kept = stale.kept;
    if (stale.removable.length) logger.success(`Removed ${stale.removable.length} stale generated file(s) that were never edited.`);
    if (stale.kept.length) logger.warn(`${stale.kept.length} file(s) from the previous generation are no longer generated but were kept (edited, or no checksum to prove otherwise). Review them, or re-run with --prune.`);
  }

  if (useGit) {
    applied.changedFiles = (tryGit(['status', '--porcelain', '-uall'], cwd) ?? '').split('\n').filter(Boolean).map(l => l.slice(3));
    if (options.commit && applied.changedFiles.length) {
      git(['add', '-A'], cwd);
      git(['commit', '-q', '-m', `chore: Upgrade gherkin-ai project to v${CLI_VERSION}`, '-m', `Regenerated ${applied.regenerated.length} feature(s) with ${CLI_NAME} v${CLI_VERSION}${analysis.generated.oldest ? ` (previously v${analysis.generated.oldest})` : ''}.`], cwd);
      applied.commit = git(['rev-parse', '--short', 'HEAD'], cwd);
    }
  }

  getTelemetry().recordAudit({
    action: 'upgrade:apply',
    resource: applied.branch ?? cwd,
    status: 'SUCCESS',
    details: `from=${analysis.generated.oldest ?? 'unknown'} to=${CLI_VERSION} regenerated=${applied.regenerated.length} removed=${applied.removed.length}`
  });
  return applied;
}

function nextSteps(analysis: Analysis, applied: UpgradeApplied | null, summary: UpgradeReport['summary'], options: UpgradeOptions): string[] {
  const steps: string[] = [];
  if (!applied) {
    if (summary.auto) steps.push('Run `ghk upgrade --apply` to apply the automatic changes on a new branch.');
  } else {
    if (applied.branch && applied.baseBranch) steps.push(`Review the changes: git diff ${applied.baseBranch}...${applied.branch} --stat${applied.commit ? '' : ' (not committed yet; `git status`)'}`);
    else if (!applied.commit) steps.push('Review the changes with `git status` / `git diff`.');
    const validate = path.join(analysis.outputAbs, 'validate.sh');
    if (fs.existsSync(validate)) steps.push(`Build and test the generated project: bash ${posix(path.relative(process.cwd(), validate))}`);
    else steps.push(`Build and test the generated project in ${analysis.outputDir}.`);
    steps.push('Run `ghk lint` and `ghk converge` to check the specs and the implementation.');
    if (applied.branch) steps.push(`Open a pull request from ${applied.branch} once it builds.`);
  }
  if (summary.manual) steps.push(`Resolve the ${summary.manual} manual item(s) listed above (see docs/MIGRATION-3.0.md).`);
  if (!options.check && !applied && !summary.required && !summary.recommended) steps.push('Nothing to do: the project is up to date.');
  return steps;
}

const SEVERITY_ICON: Record<UpgradeFinding['severity'], string> = { required: '✖', recommended: '▲', info: '·' };
const AREA_TITLE: Record<UpgradeFinding['area'], string> = {
  cli: 'CLI', generated: 'Generated code', config: 'Configuration', automation: 'CI / scripts', mcp: 'MCP clients', legacy: 'Legacy files'
};

function render(report: UpgradeReport, { findings = true } = {}): void {
  if (findings) renderFindings(report);
  if (report.applied) {
    const a = report.applied;
    logger.success(`\nApplied${a.branch ? ` on branch ${a.branch}` : ''}: ${a.regenerated.length} feature(s) regenerated, ${a.removed.length} stale file(s) removed, ${a.changedFiles.length} file(s) changed${a.commit ? `, committed ${a.commit}` : ''}.`);
  }
  if (report.nextSteps.length) {
    logger.info('\nNext steps:');
    report.nextSteps.forEach((step, i) => logger.info(`  ${i + 1}. ${step}`));
  }
}

function renderFindings(report: UpgradeReport): void {
  logger.info(`\ngherkin-ai upgrade: ${report.from ? `v${report.from}` : 'unknown version'} → v${report.to}`);
  for (const area of Object.keys(AREA_TITLE) as UpgradeFinding['area'][]) {
    const items = report.findings.filter(f => f.area === area);
    if (!items.length) continue;
    logger.info(`\n${AREA_TITLE[area]}`);
    for (const f of items) {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
      const fix = f.fix === 'auto' ? ' [auto]' : f.fix === 'manual' && f.severity !== 'info' ? ' [manual]' : '';
      const line = `  ${SEVERITY_ICON[f.severity]} ${f.message}${where}${fix}`;
      if (f.severity === 'required') logger.warn(line);
      else logger.info(line);
      if (f.hint && f.severity !== 'info') logger.info(`      → ${f.hint}`);
    }
  }
  const s = report.summary;
  logger.info(`\n${s.required} required, ${s.recommended} recommended (${s.auto} automatic, ${s.manual} manual).`);
}

export async function handleUpgradeCommand(options: UpgradeOptions = {}): Promise<UpgradeReport> {
  const cwd = process.cwd();
  if (options.apply && options.check) throw new UsageError('--check and --apply cannot be combined.');
  if (options.commit && options.git === false) throw new UsageError('--commit needs git (drop --no-git).');

  const analysis = await analyzeProject(options, cwd);
  const json = Boolean(options.json || getRunContext().json);
  let summary = summarize(analysis.findings);

  let apply = Boolean(options.apply);
  let previewed = false;
  if (!apply && !options.check && !json && !isNonInteractive(options) && summary.auto > 0 && process.stdin.isTTY) {
    const preview: UpgradeReport = { ok: true, from: analysis.generated.oldest, to: CLI_VERSION, projectConfig: fs.existsSync(analysis.configPath) ? analysis.configRel : null, outputDir: analysis.outputDir, features: analysis.features, findings: analysis.findings, summary, applied: null, nextSteps: [] };
    renderFindings(preview);
    previewed = true;
    const { default: inquirer } = await import('inquirer');
    const { proceed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'proceed',
      message: options.git === false ? 'Apply the automatic changes in the working tree?' : `Apply the automatic changes on a new branch (${options.branch || `ghk-upgrade-v${CLI_VERSION}`})?`,
      default: true
    }]);
    apply = proceed;
  }

  const applied = apply ? await applyUpgrade(analysis, options, cwd) : null;
  if (applied?.configUpdated) {
    // The fixed items are done; keep the rest of the report as is.
    analysis.findings = analysis.findings.filter(f => !(f.area === 'config' && f.fix === 'auto'));
  }
  if (applied?.regenerated.length) {
    analysis.findings = analysis.findings.filter(f => f.area !== 'generated' || f.fix !== 'auto');
    if (applied.kept.length) {
      analysis.findings.push({ id: 'generated.stale-kept', area: 'generated', severity: 'recommended', fix: 'manual', message: `${applied.kept.length} file(s) from the previous generation are no longer generated: ${applied.kept.slice(0, 5).join(', ')}${applied.kept.length > 5 ? ', ...' : ''}`, hint: 'Delete them if they are unused, or re-run with --prune.' });
    }
  }
  summary = summarize(analysis.findings);

  const report: UpgradeReport = {
    ok: summary.required === 0,
    from: analysis.generated.oldest,
    to: CLI_VERSION,
    projectConfig: fs.existsSync(analysis.configPath) ? analysis.configRel : null,
    outputDir: analysis.outputDir,
    features: analysis.features,
    findings: analysis.findings,
    summary,
    applied,
    nextSteps: nextSteps(analysis, applied, summary, options)
  };

  if (json) emitJson(report);
  else render(report, { findings: !previewed });

  if (options.check && summary.required > 0) {
    throw new GhkError(`${summary.required} required upgrade change(s) pending.`, ExitCode.GATE_FAILED, { hint: 'Run `ghk upgrade` locally to review and apply them.' });
  }
  return report;
}
