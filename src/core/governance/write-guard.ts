/* ==========================================================================
   gherkin-ai-cli - Guard for agent-driven writes (verify --auto-fix --apply,
   autopilot --apply)

   LLM-generated code must not land unattended:
   - in CI, unless policy.allowUnattendedWrites or --allow-unattended-writes,
   - on a protected branch (policy.protectedBranches, default main/master),
     unless --force-branch,
   - on a path the agent firewall does not ALLOW (saved as a proposal instead).
   Every decision is written to the audit trail.
   ========================================================================== */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { GherkinAIConfig } from '../config';
import type { AgentFirewall, FirewallDecision } from './agent-firewall';
import { logger } from '../../utils/logger';
import { PolicyError } from '../errors';
import { isCI } from '../run-context';
import { getTelemetry } from '../telemetry';

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'];

export interface AgentWriteOptions {
  command: string;
  allowUnattendedWrites?: boolean;
  forceBranch?: boolean;
  /** Injected for tests. */
  branch?: string | null;
  ci?: boolean;
}

export function currentGitBranch(cwd = process.cwd()): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null; // not a git repository
  }
}

/**
 * Writes one agent-generated file if the agent firewall allows it. Anything else (DENY or
 * REQUIRE_APPROVAL) is saved as a proposal in .ghe/patches for a human to review instead.
 * Returns the decision so the caller can report it.
 */
export function writeAgentFile(firewall: AgentFirewall, fullPath: string, content: string, command: string): FirewallDecision & { proposalPath?: string } {
  const decision = firewall.check({ kind: 'write', target: fullPath, agent: command });
  if (decision.verdict === 'ALLOW') {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return decision;
  }
  const patchDir = path.join(firewall.policy.workspace, '.ghe', 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  const proposalPath = path.join(patchDir, `${path.basename(fullPath)}.proposed`);
  fs.writeFileSync(proposalPath, content, 'utf8');
  return { ...decision, proposalPath };
}

export function reportAgentWrite(result: ReturnType<typeof writeAgentFile>, displayPath: string, what = 'changes'): void {
  if (result.verdict === 'ALLOW') logger.success(`Wrote ${what} to ${displayPath}`);
  else logger.warn(`Agent firewall: ${result.verdict} for ${displayPath} — ${result.reason} Proposal saved to ${result.proposalPath} for review.`);
}

export function assertAgentWritesAllowed(config: GherkinAIConfig, options: AgentWriteOptions): void {
  const telemetry = getTelemetry();
  const deny = (message: string, hint: string): never => {
    telemetry.recordAudit({ action: `${options.command}:agent-write`, status: 'BLOCKED', details: message });
    throw new PolicyError(message, { hint });
  };

  const ci = options.ci ?? isCI();
  if (ci && !(options.allowUnattendedWrites || config.policy?.allowUnattendedWrites)) {
    deny(
      `Refusing to write LLM-generated changes unattended in CI (${options.command}).`,
      'Review the generated .patch files instead, or opt in with --allow-unattended-writes / policy.allowUnattendedWrites.'
    );
  }

  const branch = options.branch === undefined ? currentGitBranch() : options.branch;
  const protectedBranches = config.policy?.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES;
  if (branch && protectedBranches.includes(branch) && !options.forceBranch) {
    deny(`Refusing to write LLM-generated changes on protected branch "${branch}" (${options.command}).`, 'Create a feature branch, or pass --force-branch.');
  }

  telemetry.recordAudit({ action: `${options.command}:agent-write`, status: 'SUCCESS', resource: branch ?? undefined, details: ci ? 'ci' : 'interactive' });
}
