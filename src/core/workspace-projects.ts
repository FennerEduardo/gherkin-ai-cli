/* ==========================================================================
   gherkin-ai-cli - Every gherkin-ai project under a directory (monorepos)

   `ghk lint --all` and `ghk converge --all` walk a monorepo: each directory
   with a gherkin-ai.config.json is a project, and each .feature file in its
   spec directory is checked.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { resolveSpecDir } from '../utils/spec-dir-resolver';
import { UsageError } from './errors';

const CONFIG_FILE = 'gherkin-ai.config.json';
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'bin', 'obj', 'vendor', 'deps', '_build', '.venv', 'coverage', '.next', '.dart_tool', '.gradle']);

/** Directories under `root` (including root) that contain a gherkin-ai.config.json, sorted. */
export function findGhkProjects(root: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) found.push(dir);
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found.sort();
}

/** The .feature files of a project, from its configured specDir (or features/, specs/, spec/). */
export function projectFeatureFiles(projectDir: string): string[] {
  let specDir: string | undefined;
  try {
    specDir = JSON.parse(fs.readFileSync(path.join(projectDir, CONFIG_FILE), 'utf8')).specDir;
  } catch {
    // The config is validated by `ghk config validate`; here a missing specDir falls back to the defaults.
  }
  const dir = resolveSpecDir(specDir, projectDir);
  return fs.readdirSync(dir).filter(f => f.endsWith('.feature')).sort().map(f => path.join(dir, f));
}

/** The project's feature files, or [] when it has no spec directory. */
function featureFilesOrNone(projectDir: string): string[] {
  try {
    return projectFeatureFiles(projectDir);
  } catch {
    return [];
  }
}

const slugOf = (s: string) => s.toLowerCase().replace(/\.feature$/, '').replace(/[^a-z0-9]/g, '');

/**
 * What `-f/--feature` means in every command: a path (relative to the project), or the name of a feature in the
 * spec directory (`orders`, `orders.feature`, `grade-publication` for grade_publication.feature).
 * A feature that cannot be found is a usage error (exit 2) that lists the ones there are.
 */
export function resolveFeatureFile(feature: string, projectDir: string = process.cwd()): string {
  const asPath = path.resolve(projectDir, feature);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return asPath;
  const available = featureFilesOrNone(projectDir);
  const byName = available.find(f => slugOf(path.basename(f)) === slugOf(path.basename(feature)));
  if (byName) return byName;
  const names = available.map(f => path.basename(f, '.feature'));
  throw new UsageError(`Feature not found: ${feature}`, {
    hint: names.length ? `Features in this project: ${names.join(', ')}.` : 'This project has no feature files (features/, specs/ or the configured specDir).'
  });
}

/**
 * The features a project-wide `lint`, `validate` or `converge` checks. None is a usage error (exit 2): a
 * pipeline pointed at the wrong --project must not pass. `allowEmpty` turns it into an empty result.
 */
export function requireProjectFeatures(projectDir: string, allowEmpty = false): string[] {
  const files = featureFilesOrNone(projectDir);
  if (files.length === 0 && !allowEmpty) {
    throw new UsageError(`No feature files found in ${projectDir}.`, {
      hint: 'Put them in features/ or specs/ (or set specDir), pass --feature <file>, or --allow-empty to accept a project without features.'
    });
  }
  return files;
}

export interface FeatureRow {
  project: string;
  feature: string;
  score: number | null;
  passed: boolean;
  status?: string;
  error?: string;
}

/** Runs `check` on every feature of every project under `root`; problems become failing rows. */
export function forEachProjectFeature(root: string, check: (projectDir: string, featureFile: string) => Omit<FeatureRow, 'project' | 'feature'>): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const projects = findGhkProjects(root);
  for (const projectDir of projects) {
    const project = path.relative(root, projectDir).replace(/\\/g, '/') || '.';
    let files: string[];
    try {
      files = projectFeatureFiles(projectDir);
    } catch (e: any) {
      rows.push({ project, feature: '-', score: null, passed: false, error: String(e.message).split('\n')[0] });
      continue;
    }
    for (const file of files) {
      const feature = path.relative(projectDir, file).replace(/\\/g, '/');
      try {
        rows.push({ project, feature, ...check(projectDir, file) });
      } catch (e: any) {
        rows.push({ project, feature, score: null, passed: false, error: String(e.message).split('\n')[0] });
      }
    }
  }
  return rows;
}

/** Plain-text table of the rows (project, feature, score, result). */
export function formatFeatureTable(rows: FeatureRow[], scoreLabel: string): string {
  const header = ['Project', 'Feature', scoreLabel, 'Result'];
  const body = rows.map(r => [r.project, r.feature, r.score === null ? '-' : String(r.score), r.error ? `ERROR: ${r.error}` : (r.passed ? 'pass' : 'FAIL') + (r.status ? ` (${r.status})` : '')]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), widths.map(w => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
