/* ==========================================================================
   gherkin-ai-cli - 'bench' command: A/B benchmark of an agent with and without ghk

   ghk bench init <dir>
   ghk bench run <dir> [--agent <cmd>] [--repetitions n] [--arms control,ghk] [--out dir] [--dry-run]
   ========================================================================== */

import path from 'path';
import { UsageError } from '../core/errors';
import { initBenchTask, renderBenchMarkdown, runBenchmark } from '../core/bench/harness';
import { emitData, emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface BenchCommandOptions {
  agent?: string;
  repetitions?: string;
  arms?: string;
  out?: string;
  dryRun?: boolean;
  json?: boolean;
}

export async function handleBenchCommand(subcommand: string | undefined, dir: string | undefined, options: BenchCommandOptions = {}): Promise<void> {
  if (!dir) throw new UsageError('Missing task directory.', { hint: 'ghk bench init <dir>, then ghk bench run <dir>.' });
  const taskDir = path.resolve(process.cwd(), dir);

  if (subcommand === 'init') {
    const written = initBenchTask(taskDir);
    if (options.json) return emitJson({ taskDir, written });
    for (const f of written) logger.success(`Created ${path.join(dir, f)}`);
    logger.info('Edit bench.json (agent command and checks), REQUIREMENTS.md and features/, then run `ghk bench run ' + dir + ' --dry-run`.');
    return;
  }
  if (subcommand !== 'run') throw new UsageError(`Unknown bench subcommand "${subcommand ?? ''}".`, { hint: 'Use `ghk bench init <dir>` or `ghk bench run <dir>`.' });

  const repetitions = options.repetitions ? Number(options.repetitions) : undefined;
  if (repetitions !== undefined && (!Number.isInteger(repetitions) || repetitions < 1)) throw new UsageError('--repetitions must be a positive integer.');
  const outDir = path.resolve(process.cwd(), options.out ?? path.join(dir, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
  if (!options.dryRun) logger.warn('The benchmark runs your agent command once per arm and repetition; that may consume paid model usage.');

  let report;
  try {
    report = runBenchmark(taskDir, {
      agent: options.agent,
      repetitions,
      arms: options.arms?.split(',').map(a => a.trim()).filter(Boolean),
      outDir,
      dryRun: options.dryRun,
      onProgress: message => logger.info(message)
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (options.json) return emitJson({ ...report, outDir });
  emitData(renderBenchMarkdown(report));
  logger.success(`Report written to ${path.relative(process.cwd(), outDir)}/report.{json,md}`);
}
