/* ==========================================================================
   gherkin-ai-cli - Guard for agent-driven writes (verify --auto-fix --apply,
   autopilot --apply)

   LLM-generated code must not land unattended:
   - in CI, unless policy.allowUnattendedWrites or --allow-unattended-writes,
   - on a protected branch (policy.protectedBranches, default main/master),
     unless --force-branch.
   Every decision is written to the audit trail.
   ========================================================================== */

import { execFileSync } from 'child_process';
import type { GherkinAIConfig } from '../config';
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
