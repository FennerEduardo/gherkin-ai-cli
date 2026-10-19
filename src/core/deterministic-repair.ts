/* ==========================================================================
   gherkin-ai-cli - Deterministic repair before the LLM (4.5)

   `ghk verify --auto-fix` asks an LLM to fix a failing build or test run. For
   failures with a mechanical cause these rules decide first, with no model:
   - fix: run the toolchain's dependency command (missing dependency,
     lockfile out of sync), then run the tests again;
   - stop: the failure is not a code bug (missing database / broker
     variables, pending .ghk-new kernel files): explain what to do instead
     of spending model calls on it.
   Each rule fires at most once per verify run.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from './config';
import { resolveToolchain } from '../generators/toolchains';

export interface RepairPlan {
  ruleId: string;
  explanation: string;
  /** Command that fixes it (run, then the tests run again). */
  command?: string;
  /** Not a code problem: end the loop with this explanation instead of calling the LLM. */
  stop?: boolean;
}

interface RepairRule {
  id: string;
  match: (log: string, ctx: RepairContext) => RepairPlan | undefined;
}

export interface RepairContext {
  projectDir: string;
  config?: Partial<GherkinAIConfig>;
}

const MISSING_DEPENDENCY = [
  /Cannot find module '([^'.][^']*)'/, // Node (bare package, not a relative import)
  /ModuleNotFoundError: No module named '([^']+)'/, // Python
  /no required module provides package ([^\s;]+)/, // Go
  /cannot load such file -- ([^\s(]+)/, // Ruby
  /Could not resolve dependencies for project|Could not find artifact ([^\s]+)/, // Maven
  /could not find (?:dependency|package) `?([^\s`]+)`?/i // Cargo / Mix
];

const LOCKFILE_OUT_OF_SYNC = [
  /npm (?:ci|error) .*package\.json and package-lock\.json .*(?:not in sync|out of sync)/i,
  /`npm ci` can only install packages when your package\.json and package-lock\.json/i,
  /go: updates to go\.mod needed|missing go\.sum entry/,
  /The gemspecs? for .* changed|Your lockfile is unreadable|Run `bundle install`/,
  /mix\.lock is out of date|the dependency .* is out of date/i,
  /lock file is not up to date with the latest changes in composer\.json/i,
  /the lock file .*Cargo\.lock needs to be updated/i
];

const MISSING_SERVICES = /(?:DATABASE_URL|AMQP_URL)(?: is not set| \(| and AMQP_URL| or AMQP_URL)|Integration tests need DATABASE_URL|ECONNREFUSED [^\n]*:(?:5432|5672)\b|Connection refused[^\n]*(?:5432|5672)/;

function dependencyCommand(ctx: RepairContext): string | undefined {
  // The toolchain's first build command restores the dependencies (npm install, pip install, go mod tidy, ...).
  if (!ctx.config?.stack) return undefined;
  return resolveToolchain(ctx.config as GherkinAIConfig)?.build[0];
}

function pendingKernelVersions(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'vendor', 'target', 'dist', 'build', '_build', 'deps'].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.ghk-new')) out.push(path.relative(projectDir, path.join(dir, e.name)));
    }
  };
  walk(projectDir, 0);
  return out;
}

const RULES: RepairRule[] = [
  {
    id: 'missing-services',
    match: log => MISSING_SERVICES.test(log)
      ? { ruleId: 'missing-services', stop: true, explanation: 'The runtime integration tests need PostgreSQL and the broker; this is not a code bug. Run them with "ghk verify --services" (starts PostgreSQL and RabbitMQ) or set DATABASE_URL and AMQP_URL.' }
      : undefined
  },
  {
    id: 'pending-generated-versions',
    match: (log, ctx) => {
      const pending = pendingKernelVersions(ctx.projectDir);
      if (!pending.length || !/error|cannot find|undefined|not found|unresolved|does not exist/i.test(log)) return undefined;
      return { ruleId: 'pending-generated-versions', stop: true, explanation: `Newer generated versions are waiting next to edited files (${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', ...' : ''}); the code may not compile until they are merged. Run "ghk generate --review".` };
    }
  },
  {
    id: 'lockfile-out-of-sync',
    match: (log, ctx) => {
      if (!LOCKFILE_OUT_OF_SYNC.some(p => p.test(log))) return undefined;
      const command = dependencyCommand(ctx);
      return command ? { ruleId: 'lockfile-out-of-sync', command, explanation: `The lockfile is out of sync with the manifest; restoring the dependencies with "${command}".` } : undefined;
    }
  },
  {
    id: 'missing-dependency',
    match: (log, ctx) => {
      const hit = MISSING_DEPENDENCY.map(p => p.exec(log)).find(Boolean);
      if (!hit) return undefined;
      const command = dependencyCommand(ctx);
      return command ? { ruleId: 'missing-dependency', command, explanation: `A dependency is not installed${hit[1] ? ` (${hit[1]})` : ''}; restoring the dependencies with "${command}".` } : undefined;
    }
  }
];

/** The first deterministic repair for a failure log, skipping rules already tried in this run. */
export function planDeterministicRepair(log: string, ctx: RepairContext, alreadyTried: ReadonlySet<string> = new Set()): RepairPlan | undefined {
  for (const rule of RULES) {
    if (alreadyTried.has(rule.id)) continue;
    const plan = rule.match(log, ctx);
    if (plan) return plan;
  }
  return undefined;
}
