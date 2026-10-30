/* ==========================================================================
   gherkin-ai-cli - 'speckit' command: GitHub Spec Kit import / export

   ghk speckit import [--dir specs] [--out features] [--force]
   ghk speckit export [--out specs] [--force]
   ghk speckit verify [--dir specs] [--out features] [--threshold 80]
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { ExitCode, UsageError } from '../core/errors';
import { parseGherkinText } from '../core/gherkin-parser';
import { featureToSpecKit, parseSpecKitSpec, parseSpecKitTasks, specKitToFeature, verifySpecKitFeature } from '../core/interop/speckit';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface SpeckitCommandOptions {
  dir?: string;
  out?: string;
  force?: boolean;
  json?: boolean;
  /** verify: minimum convergence (default 80). */
  threshold?: string;
}

interface Converted {
  source: string;
  target: string;
  status: 'written' | 'skipped-exists';
  clarifications?: string[];
}

function specKitRoot(cwd: string, dir?: string): string {
  const candidates = dir ? [dir] : ['specs', '.specify/specs'];
  const found = candidates.map(d => path.resolve(cwd, d)).find(d => fs.existsSync(d));
  if (!found) throw new UsageError('No Spec Kit specs directory found.', { hint: 'Pass --dir <path> (Spec Kit keeps specs/NNN-feature/spec.md).' });
  return found;
}

function writeIfAllowed(target: string, content: string, force: boolean | undefined): Converted['status'] {
  if (fs.existsSync(target) && !force) return 'skipped-exists';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return 'written';
}

/** Agent instruction files Spec Kit and the agents read; they should send the agent through the gates. */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules'];

/**
 * `ghk speckit verify`: for each Spec Kit feature folder, is the plan covered by the executable specification,
 * and does the code converge with it? Drift (a story, requirement or completed task with no scenario, or
 * convergence below the threshold) exits 7.
 */
async function verify(cwd: string, options: SpeckitCommandOptions): Promise<void> {
  const root = specKitRoot(cwd, options.dir);
  const featuresDir = path.resolve(cwd, options.out ?? 'features');
  const threshold = parseInt(options.threshold ?? '80', 10);
  const { calculateConvergence } = await import('../core/convergence-engine');
  const rows = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'spec.md')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const dir = path.join(root, entry.name);
      const spec = parseSpecKitSpec(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8'));
      const tasks = fs.existsSync(path.join(dir, 'tasks.md')) ? parseSpecKitTasks(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8')) : [];
      const featureFile = path.join(featuresDir, `${entry.name.replace(/^\d+-/, '')}.feature`);
      const parsed = fs.existsSync(featureFile) ? parseGherkinText(fs.readFileSync(featureFile, 'utf8')) : undefined;
      const findings = verifySpecKitFeature(spec, parsed, tasks);
      const convergence = parsed ? calculateConvergence(parsed, featureFile, cwd).overallConvergence : null;
      const drift = findings.some(f => f.drift) || (convergence !== null && convergence < threshold);
      return {
        spec: path.relative(cwd, dir).split(path.sep).join('/'),
        feature: parsed ? path.relative(cwd, featureFile).split(path.sep).join('/') : null,
        stories: spec.stories.length, requirements: spec.requirements.length,
        tasks: { total: tasks.length, done: tasks.filter(t => t.done).length },
        convergence, drift, findings
      };
    });
  const agentFiles = AGENT_FILES.filter(f => fs.existsSync(path.join(cwd, f)));
  const ungated = agentFiles.filter(f => {
    const p = path.join(cwd, f);
    const text = fs.statSync(p).isDirectory() ? fs.readdirSync(p).map(n => { try { return fs.readFileSync(path.join(p, n), 'utf8'); } catch { return ''; } }).join('\n') : fs.readFileSync(p, 'utf8');
    return !/\bghk\b|gherkin-ai/.test(text);
  });
  if (rows.some(r => r.drift)) process.exitCode = ExitCode.DRIFT;

  if (options.json) {
    emitJson({ threshold, specs: rows, agentInstructions: { files: agentFiles, withoutGates: ungated } });
    return;
  }
  if (rows.length === 0) logger.warn('No Spec Kit feature folders (specs/NNN-name/spec.md) found.');
  for (const r of rows) {
    const status = r.drift ? 'DRIFT' : 'OK';
    console.log(`${status.padEnd(6)} ${r.spec} → ${r.feature ?? '(not imported)'}  stories ${r.stories}, FR ${r.requirements}, tasks ${r.tasks.done}/${r.tasks.total} done${r.convergence !== null ? `, convergence ${r.convergence}%` : ''}`);
    for (const f of r.findings) console.log(`       ${f.drift ? '✖' : 'ℹ'} ${f.message}`);
    if (r.convergence !== null && r.convergence < threshold) console.log(`       ✖ Convergence ${r.convergence}% is below ${threshold}%: run \`ghk converge -f ${r.feature}\` for the dimensions.`);
  }
  for (const f of ungated) logger.warn(`${f} does not mention ghk: agents following it skip the specification gates (add \`ghk lint\` / \`ghk converge\` to its checklist, or \`ghk skill\`).`);
}

export async function handleSpeckitCommand(subcommand: string | undefined, options: SpeckitCommandOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const results: Converted[] = [];
  if (subcommand === 'verify') return verify(cwd, options);
  if (subcommand === 'import') {
    const root = specKitRoot(cwd, options.dir);
    const outDir = path.resolve(cwd, options.out ?? 'features');
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const specFile = path.join(root, entry.name, 'spec.md');
      if (!fs.existsSync(specFile)) continue;
      const spec = parseSpecKitSpec(fs.readFileSync(specFile, 'utf8'));
      const target = path.join(outDir, `${entry.name.replace(/^\d+-/, '')}.feature`);
      results.push({ source: path.relative(cwd, specFile), target: path.relative(cwd, target), status: writeIfAllowed(target, specKitToFeature(spec), options.force), clarifications: spec.clarifications });
    }
  } else if (subcommand === 'export') {
    let specDir: string;
    try {
      specDir = resolveSpecDir(process.env.GHK_SPEC_DIR, cwd);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const outDir = path.resolve(cwd, options.out ?? 'specs');
    if (path.resolve(specDir) === outDir) throw new UsageError('The export directory is the .feature directory.', { hint: 'Pass --out <dir> for the Spec Kit specs.' });
    const features = fs.readdirSync(specDir).filter(f => f.endsWith('.feature')).sort();
    features.forEach((file, i) => {
      const parsed = parseGherkinText(fs.readFileSync(path.join(specDir, file), 'utf8'));
      const folder = `${String(i + 1).padStart(3, '0')}-${path.basename(file, '.feature')}`;
      const target = path.join(outDir, folder, 'spec.md');
      results.push({ source: path.relative(cwd, path.join(specDir, file)), target: path.relative(cwd, target), status: writeIfAllowed(target, featureToSpecKit(parsed, { branch: folder }), options.force) });
    });
  } else {
    throw new UsageError(`Unknown speckit subcommand "${subcommand ?? ''}".`, { hint: 'Use `ghk speckit import`, `ghk speckit export` or `ghk speckit verify`.' });
  }

  if (options.json) {
    emitJson({ direction: subcommand, results });
    return;
  }
  if (results.length === 0) logger.warn('Nothing to convert.');
  for (const r of results) {
    if (r.status === 'written') logger.success(`${r.source} → ${r.target}`);
    else logger.warn(`${r.target} exists; skipped (use --force to overwrite)`);
    for (const c of r.clarifications ?? []) logger.warn(`  Needs clarification: ${c}`);
  }
  if (subcommand === 'import' && results.some(r => r.status === 'written')) logger.info('Next: ghk lint, then ghk generate / ghk implement for each imported feature.');
}
