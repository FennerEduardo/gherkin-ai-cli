/* ==========================================================================
   gherkin-ai-cli - A/B benchmark harness ("does the agent do better with ghk?")

   A task folder:
     bench.json         { name, agent, checks, timeoutMinutes, repetitions, arms? }
     REQUIREMENTS.md    what to build (both arms get it)
     features/          the executable specification (ghk arm only)
     seed/              optional starting project (both arms)
     acceptance/        hidden acceptance tests, copied in only AFTER the agent ran

   Arms (same agent command, model, prompt template, timeout and machine):
     control  seed + REQUIREMENTS.md
     ghk      seed + REQUIREMENTS.md + features/ + deterministic `ghk generate`

   Every arm is scored with the same deterministic checks (build, tests,
   hidden acceptance tests, spec-to-code convergence, files touched, time).
   The harness never calls an LLM itself: the agent is whatever command the
   user configures, so `--dry-run` costs nothing.
   ========================================================================== */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseGherkinText } from '../gherkin-parser';
import { calculateConvergence } from '../convergence-engine';

export interface BenchArm {
  name: string;
  /** Copy features/ into the workspace. */
  specs: boolean;
  /** Commands run in the workspace before the agent; {ghk} is the CLI, {feature} each feature path. */
  prepare: string[];
  /** Extra prompt text for this arm. */
  promptAddendum?: string;
}

export interface BenchTask {
  name: string;
  /** Agent command run in the workspace; {prompt_file}, {workspace} and {arm} are substituted. */
  agent: string;
  /** Prompt template; {requirements} is replaced by REQUIREMENTS.md. */
  prompt?: string;
  checks: { build?: string; test?: string; acceptance?: string };
  timeoutMinutes?: number;
  repetitions?: number;
  arms?: BenchArm[];
}

export interface CheckResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
}

export interface ArmRun {
  arm: string;
  repetition: number;
  workspace: string;
  agent?: { exitCode: number | null; durationMs: number; timedOut: boolean };
  checks: Partial<Record<'build' | 'test' | 'acceptance', CheckResult>>;
  convergence?: number;
  filesChanged: number;
  linesAdded: number;
}

export interface BenchReport {
  task: string;
  startedAt: string;
  dryRun: boolean;
  runs: ArmRun[];
  summary: Record<string, { runs: number; buildPassRate?: number; testPassRate?: number; acceptancePassRate?: number; meanConvergence?: number; meanAgentSeconds?: number; meanFilesChanged: number }>;
}

export const DEFAULT_PROMPT = `Implement the following requirements in this repository. Work autonomously until the build and the tests pass.

{requirements}`;

export const DEFAULT_ARMS: BenchArm[] = [
  { name: 'control', specs: false, prepare: [] },
  {
    name: 'ghk',
    specs: true,
    prepare: ['{ghk} --yes generate -f {feature}'],
    promptAddendum: 'The executable specification is in features/ (Gherkin) and the generated contracts are in the repository. Make every scenario pass; check your work with `ghk verify` and `ghk converge`.'
  }
];

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__', 'coverage', '.gherkin-ai', '.ghe']);

function copyDir(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, { recursive: true, filter: src => !IGNORED.has(path.basename(src)) });
}

function snapshot(dir: string): Map<string, { hash: string; lines: number }> {
  const files = new Map<string, { hash: string; lines: number }>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const content = fs.readFileSync(abs);
        files.set(path.relative(dir, abs), { hash: crypto.createHash('sha1').update(content).digest('hex'), lines: content.toString('utf8').split('\n').length });
      }
    }
  };
  walk(dir);
  return files;
}

function run(command: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = {}): CheckResult & { timedOut: boolean; output: string } {
  const started = Date.now();
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { command, passed: result.status === 0, exitCode: result.status, durationMs: Date.now() - started, timedOut, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const quote = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

export function ghkInvocation(): string {
  return `${quote(process.execPath)} ${quote(path.resolve(__dirname, '../../../bin/gherkin-ai.js'))}`;
}

export function loadBenchTask(taskDir: string): BenchTask {
  const file = path.join(taskDir, 'bench.json');
  if (!fs.existsSync(file)) throw new Error(`No bench.json in ${taskDir} (create one with \`ghk bench init ${taskDir}\`).`);
  const task = JSON.parse(fs.readFileSync(file, 'utf8')) as BenchTask;
  if (!task.agent) throw new Error('bench.json must define "agent" (the command that runs your coding agent).');
  if (!fs.existsSync(path.join(taskDir, 'REQUIREMENTS.md'))) throw new Error(`Missing ${path.join(taskDir, 'REQUIREMENTS.md')}.`);
  return { ...task, name: task.name ?? path.basename(taskDir), checks: task.checks ?? {} };
}

function featureFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.feature')).sort() : [];
}

function meanConvergence(taskDir: string, workspace: string): number | undefined {
  const features = featureFiles(path.join(taskDir, 'features'));
  if (features.length === 0) return undefined;
  const scores = features.map(f => {
    const file = path.join(taskDir, 'features', f);
    return calculateConvergence(parseGherkinText(fs.readFileSync(file, 'utf8')), file, workspace).overallConvergence;
  });
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export interface BenchOptions {
  agent?: string;
  repetitions?: number;
  arms?: string[];
  outDir?: string;
  dryRun?: boolean;
  /** Where workspaces are created (default: a temp directory). */
  workDir?: string;
  onProgress?: (message: string) => void;
}

export function runBenchmark(taskDir: string, options: BenchOptions = {}): BenchReport {
  const task = loadBenchTask(taskDir);
  const agent = options.agent ?? task.agent;
  const repetitions = options.repetitions ?? task.repetitions ?? 1;
  const timeoutMs = (task.timeoutMinutes ?? 30) * 60_000;
  const arms = (task.arms ?? DEFAULT_ARMS).filter(a => !options.arms || options.arms.includes(a.name));
  if (arms.length === 0) throw new Error('No arms selected.');
  const requirements = fs.readFileSync(path.join(taskDir, 'REQUIREMENTS.md'), 'utf8');
  const workRoot = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-bench-'));
  const progress = options.onProgress ?? (() => undefined);
  const report: BenchReport = { task: task.name, startedAt: new Date().toISOString(), dryRun: Boolean(options.dryRun), runs: [], summary: {} };

  for (let rep = 1; rep <= repetitions; rep++) {
    for (const arm of arms) {
      const workspace = path.join(workRoot, `${arm.name}-${rep}`);
      fs.mkdirSync(workspace, { recursive: true });
      copyDir(path.join(taskDir, 'seed'), workspace);
      fs.writeFileSync(path.join(workspace, 'REQUIREMENTS.md'), requirements);
      const features = featureFiles(path.join(taskDir, 'features'));
      if (arm.specs) {
        copyDir(path.join(taskDir, 'features'), path.join(workspace, 'features'));
        if (fs.existsSync(path.join(taskDir, 'gherkin-ai.config.json'))) fs.copyFileSync(path.join(taskDir, 'gherkin-ai.config.json'), path.join(workspace, 'gherkin-ai.config.json'));
      }
      for (const template of arm.prepare) {
        const commands = template.includes('{feature}') ? features.map(f => template.replace(/\{feature\}/g, quote(path.join('features', f)))) : [template];
        for (const command of commands) {
          const result = run(command.replace(/\{ghk\}/g, ghkInvocation()), workspace, timeoutMs);
          if (!result.passed) progress(`[${arm.name}] prepare step failed (${result.exitCode}): ${command}`);
        }
      }
      const prompt = (task.prompt ?? DEFAULT_PROMPT).replace('{requirements}', requirements) + (arm.promptAddendum ? `\n\n${arm.promptAddendum}\n` : '\n');
      const promptFile = path.join(workspace, 'PROMPT.md');
      fs.writeFileSync(promptFile, prompt);

      const before = snapshot(workspace);
      const armRun: ArmRun = { arm: arm.name, repetition: rep, workspace, checks: {}, filesChanged: 0, linesAdded: 0 };
      if (options.dryRun) {
        progress(`[${arm.name} #${rep}] prepared ${workspace} (dry run: agent not started)`);
        report.runs.push(armRun);
        continue;
      }

      progress(`[${arm.name} #${rep}] running agent…`);
      const agentCommand = agent.replace(/\{prompt_file\}/g, quote(promptFile)).replace(/\{workspace\}/g, quote(workspace)).replace(/\{arm\}/g, arm.name);
      const agentRun = run(agentCommand, workspace, timeoutMs, { GHK_BENCH_ARM: arm.name, GHK_BENCH_REPETITION: String(rep) });
      armRun.agent = { exitCode: agentRun.exitCode, durationMs: agentRun.durationMs, timedOut: agentRun.timedOut };

      const after = snapshot(workspace);
      for (const [file, info] of after) {
        const previous = before.get(file);
        if (!previous || previous.hash !== info.hash) {
          armRun.filesChanged++;
          armRun.linesAdded += Math.max(0, info.lines - (previous?.lines ?? 0));
        }
      }

      // Hidden acceptance tests arrive only now, identically for every arm.
      copyDir(path.join(taskDir, 'acceptance'), workspace);
      for (const kind of ['build', 'test', 'acceptance'] as const) {
        const command = task.checks[kind];
        if (!command) continue;
        const { timedOut: _t, output: _o, ...result } = run(command, workspace, timeoutMs);
        armRun.checks[kind] = result;
      }
      armRun.convergence = meanConvergence(taskDir, workspace);
      progress(`[${arm.name} #${rep}] build=${armRun.checks.build?.passed ?? '-'} test=${armRun.checks.test?.passed ?? '-'} acceptance=${armRun.checks.acceptance?.passed ?? '-'} convergence=${armRun.convergence ?? '-'}%`);
      report.runs.push(armRun);
    }
  }

  for (const arm of arms) {
    const runs = report.runs.filter(r => r.arm === arm.name);
    const rate = (kind: 'build' | 'test' | 'acceptance') => {
      const results = runs.map(r => r.checks[kind]).filter(Boolean) as CheckResult[];
      return results.length ? results.filter(r => r.passed).length / results.length : undefined;
    };
    const mean = (values: (number | undefined)[]) => {
      const v = values.filter((x): x is number => typeof x === 'number');
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined;
    };
    report.summary[arm.name] = {
      runs: runs.length,
      buildPassRate: rate('build'),
      testPassRate: rate('test'),
      acceptancePassRate: rate('acceptance'),
      meanConvergence: mean(runs.map(r => r.convergence)),
      meanAgentSeconds: mean(runs.map(r => (r.agent ? r.agent.durationMs / 1000 : undefined))),
      meanFilesChanged: mean(runs.map(r => r.filesChanged)) ?? 0
    };
  }

  if (options.outDir) {
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(path.join(options.outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(options.outDir, 'report.md'), renderBenchMarkdown(report));
  }
  return report;
}

const pct = (v?: number) => (v === undefined ? '–' : `${Math.round(v * 100)}%`);

export function renderBenchMarkdown(report: BenchReport): string {
  const arms = Object.keys(report.summary);
  const row = (label: string, value: (s: BenchReport['summary'][string]) => string) => `| ${label} | ${arms.map(a => value(report.summary[a])).join(' | ')} |`;
  return [
    `# Benchmark: ${report.task}`,
    '',
    `Started ${report.startedAt}${report.dryRun ? ' (dry run: workspaces prepared, agent not started)' : ''}.`,
    '',
    `| Metric | ${arms.join(' | ')} |`,
    `|---|${arms.map(() => '---').join('|')}|`,
    row('Runs', s => String(s.runs)),
    row('Build passes', s => pct(s.buildPassRate)),
    row('Tests pass', s => pct(s.testPassRate)),
    row('Hidden acceptance tests pass', s => pct(s.acceptancePassRate)),
    row('Spec-to-code convergence', s => (s.meanConvergence === undefined ? '–' : `${s.meanConvergence}%`)),
    row('Agent time (s)', s => (s.meanAgentSeconds === undefined ? '–' : String(s.meanAgentSeconds))),
    row('Files changed', s => String(s.meanFilesChanged)),
    '',
    'Same agent command, prompt template, timeout and machine for every arm; acceptance tests are copied in only after the agent finishes.',
    ''
  ].join('\n');
}

/** Scaffolds a task folder. */
export function initBenchTask(dir: string): string[] {
  const files: Record<string, string> = {
    'bench.json': JSON.stringify({
      name: path.basename(path.resolve(dir)),
      agent: 'claude -p "$(cat {prompt_file})" --permission-mode acceptEdits',
      checks: { build: 'npm install --no-audit --no-fund && npm run build', test: 'npm test', acceptance: 'npx vitest run acceptance' },
      timeoutMinutes: 30,
      repetitions: 3
    }, null, 2) + '\n',
    'REQUIREMENTS.md': '# Requirements\n\nDescribe what the agent must build, exactly as you would brief a developer.\n',
    'features/README.md': 'Put the .feature files for the ghk arm here (write them with `ghk create`, or `ghk speckit import`).\n',
    'seed/README.md': 'Optional starting project copied into every arm (leave empty to start from scratch).\n',
    'acceptance/README.md': 'Hidden acceptance tests, copied into each workspace only after the agent finished.\n'
  };
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(rel);
  }
  return written;
}
