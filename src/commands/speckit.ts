/* ==========================================================================
   gherkin-ai-cli - 'speckit' command: GitHub Spec Kit import / export

   ghk speckit import [--dir specs] [--out features] [--force]
   ghk speckit export [--out specs] [--force]
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { UsageError } from '../core/errors';
import { parseGherkinText } from '../core/gherkin-parser';
import { featureToSpecKit, parseSpecKitSpec, specKitToFeature } from '../core/interop/speckit';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface SpeckitCommandOptions {
  dir?: string;
  out?: string;
  force?: boolean;
  json?: boolean;
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

export async function handleSpeckitCommand(subcommand: string | undefined, options: SpeckitCommandOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const results: Converted[] = [];
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
    throw new UsageError(`Unknown speckit subcommand "${subcommand ?? ''}".`, { hint: 'Use `ghk speckit import` or `ghk speckit export`.' });
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
