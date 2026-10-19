/* ==========================================================================
   gherkin-ai-cli - ghk generate --review (4.10)

   Resolves the <file>.ghk-new versions that generate writes next to files
   the user edited (or protected): shows the diff, then takes the generated
   version or keeps the user's. A kept version is recorded in the inventory
   (declined checksum), so generate does not offer the same content again.
   Non-interactive: lists the pending files with their diffs and exits 4,
   unless --accept-new or --keep-mine resolves all of them.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../core/config';
import { ExitCode } from '../core/errors';
import { readInventoryFile, writeInventoryFile } from '../core/inventory';
import { isNonInteractive } from '../core/run-context';
import { NEW_SUFFIX, sha256 } from '../core/write-protection';
import { emitJson } from '../utils/output';

export interface ReviewOptions {
  config?: string;
  acceptNew?: boolean;
  keepMine?: boolean;
  json?: boolean;
}

export interface PendingVersion {
  /** Path from the project root. */
  file: string;
  /** Inventory key (path from outputDir). */
  artifact: string;
  added: number;
  removed: number;
  diff: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'target', 'build', 'dist', '_build', 'deps', 'bin', 'obj', '.venv']);

function findNewVersions(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findNewVersions(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(NEW_SUFFIX)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Line diff (longest common subsequence) rendered like a unified diff with 2 lines of context. */
export function lineDiff(current: string, next: string, maxLines = 120): { diff: string; added: number; removed: number } {
  const a = current.split('\n');
  const b = next.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ op: ' ', line: a[i] }); i++; j++; }
    else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ op: '+', line: b[j] }); j++; }
    else { ops.push({ op: '-', line: a[i] }); i++; }
  }
  const changed = ops.map((o, k) => (o.op !== ' ' ? k : -1)).filter(k => k >= 0);
  const show = new Set(changed.flatMap(k => [k - 2, k - 1, k, k + 1, k + 2]));
  const lines: string[] = [];
  let last = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!show.has(k)) continue;
    if (last >= 0 && k > last + 1) lines.push('  ...');
    lines.push(`${ops[k].op} ${ops[k].line}`);
    last = k;
  }
  const truncated = lines.length > maxLines ? [...lines.slice(0, maxLines), `  ... (${lines.length - maxLines} more lines)`] : lines;
  return { diff: truncated.join('\n'), added: ops.filter(o => o.op === '+').length, removed: ops.filter(o => o.op === '-').length };
}

export function pendingVersions(projectDir: string, outputDir: string): PendingVersion[] {
  const outRoot = path.resolve(projectDir, outputDir);
  return findNewVersions(projectDir).sort().map(newFile => {
    const target = newFile.slice(0, -NEW_SUFFIX.length);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const { diff, added, removed } = lineDiff(current, fs.readFileSync(newFile, 'utf8'));
    return {
      file: path.relative(projectDir, target).split(path.sep).join('/'),
      artifact: path.relative(outRoot, target).split(path.sep).join('/'),
      added,
      removed,
      diff
    };
  });
}

/** Applies a decision: "take" the generated version, or "keep" the user's (declined in the inventory). */
export function resolveVersion(projectDir: string, pending: PendingVersion, decision: 'take' | 'keep'): void {
  const target = path.join(projectDir, pending.file);
  const newFile = target + NEW_SUFFIX;
  const generated = fs.readFileSync(newFile, 'utf8');
  if (decision === 'take') fs.writeFileSync(target, generated);
  fs.rmSync(newFile);
  const inventoryPath = path.join(projectDir, '.ghe', 'inventory.json');
  const inventory = readInventoryFile(inventoryPath);
  const checksum = sha256(generated);
  const entry = inventory.artifacts.find(a => a.filePath.replace(/\\/g, '/') === pending.artifact);
  const updated = { ...(entry ?? { filePath: pending.artifact }), checksum };
  if (decision === 'keep') updated.declined = checksum;
  else delete updated.declined;
  inventory.artifacts = [...inventory.artifacts.filter(a => a !== entry), updated].sort((x, y) => x.filePath.localeCompare(y.filePath));
  writeInventoryFile(inventoryPath, inventory);
}

export async function handleGenerateReview(options: ReviewOptions = {}): Promise<void> {
  const config = loadConfig(options.config);
  const projectDir = process.cwd();
  const pending = pendingVersions(projectDir, config.outputDir || './');
  const bulk: 'take' | 'keep' | undefined = options.acceptNew ? 'take' : options.keepMine ? 'keep' : undefined;

  if (options.json) {
    if (bulk) for (const p of pending) resolveVersion(projectDir, p, bulk);
    emitJson({ pending: bulk ? [] : pending, resolved: bulk ? pending.map(p => ({ file: p.file, decision: bulk })) : [] });
    if (!bulk && pending.length) process.exitCode = ExitCode.GATE_FAILED;
    return;
  }

  if (!pending.length) {
    console.log(chalk.green('\n✔ No pending generated versions (.ghk-new).\n'));
    return;
  }
  console.log(chalk.bold.cyan(`\n🔀 ${pending.length} generated version(s) to review\n`));

  const interactive = !bulk && !isNonInteractive();
  let unresolved = 0;
  for (const p of pending) {
    console.log(chalk.bold(`${p.file}`) + chalk.gray(`  (+${p.added} -${p.removed}, ${NEW_SUFFIX} vs your version)`));
    console.log(p.diff.split('\n').map(l => (l.startsWith('+') ? chalk.green(l) : l.startsWith('-') ? chalk.red(l) : chalk.gray(l))).join('\n'));
    let decision: 'take' | 'keep' | 'later' = bulk ?? 'later';
    if (interactive) {
      const inquirer = (await import('inquirer')).default;
      ({ decision } = await inquirer.prompt([{
        type: 'list', name: 'decision', message: `${p.file}:`,
        choices: [
          { name: 'Take the generated version (replaces your file)', value: 'take' },
          { name: 'Keep my version (this generated version is not offered again)', value: 'keep' },
          { name: 'Decide later', value: 'later' }
        ]
      }]));
    }
    if (decision === 'later') unresolved++;
    else {
      resolveVersion(projectDir, p, decision);
      console.log(decision === 'take' ? chalk.green('  ✔ generated version taken') : chalk.yellow('  ✔ your version kept'));
    }
    console.log('');
  }
  if (unresolved) {
    console.log(chalk.yellow(`${unresolved} version(s) still pending: run "ghk generate --review" interactively, or pass --accept-new / --keep-mine.\n`));
    if (!interactive) process.exitCode = ExitCode.GATE_FAILED;
  }
}
