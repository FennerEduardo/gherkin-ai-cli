/* ==========================================================================
   gherkin-ai-cli - Enterprise Guardrails & Role-Based Enforcement Engine
   ========================================================================== */

import path from 'path';
import { loadConstitution, getAgentPermissions, Constitution } from './constitution';
import { loadConfig } from './config';
import { AgentFirewall, loadFirewallPolicy } from './governance/agent-firewall';
import { writeVerdict } from './governance/policy-session';
import { firstMatch } from '../utils/glob';

export interface GuardrailPolicies {
  requireTests: boolean;
  requireTypecheck: boolean;
  maxFilesChanged: number;
  protectedPaths: string[];
  requireHumanApproval: string[];
  allowedToolActions?: string[];
  deniedToolActions?: string[];
}

export const DEFAULT_GUARDRAILS: GuardrailPolicies = {
  requireTests: true,
  requireTypecheck: true,
  maxFilesChanged: 30,
  // On top of the agent firewall's rules (which already hold secrets, migrations and infrastructure at any depth).
  protectedPaths: ['infrastructure/**', 'migrations/**', 'config/production*', '.env', '.env.*', 'secrets/**'],
  requireHumanApproval: ['database-migration', 'auth-change', 'infrastructure-change']
};

export interface GuardrailValidationResult {
  allowed: boolean;
  violations: string[];
  requiresHumanApproval: boolean;
}

export interface AgentActionRequest {
  role?: string;
  action: 'read_spec' | 'write_spec' | 'generate_code' | 'execute_tests' | 'apply_migration' | 'deploy' | 'custom';
  targetFiles?: string[];
  toolName?: string;
  /** `repair`: an auto-fix loop, which may not change specifications, contracts or tests. */
  mode?: 'agent' | 'repair';
}

export function validateGuardrails(
  request: AgentActionRequest | string[],
  cwd: string = process.cwd(),
  customPolicies?: GuardrailPolicies
): GuardrailValidationResult {
  const violations: string[] = [];
  let requiresHumanApproval = false;

  const modifiedFiles: string[] = Array.isArray(request) ? request : (request.targetFiles || []);
  const action = Array.isArray(request) ? 'generate_code' : request.action;
  const roleName = Array.isArray(request) ? 'developer' : (request.role || 'developer');

  let policies = customPolicies || DEFAULT_GUARDRAILS;
  try {
    const constitution: Constitution | null = loadConstitution(cwd);

    if (constitution) {
      const perms = getAgentPermissions(roleName, constitution);

      if (action !== 'read_spec' && modifiedFiles.length > 0) {
        for (const file of modifiedFiles) {
          const matchesAllowed = perms.write.some((perm: string) => perm === '*' || perm === '**' || firstMatch(file, [perm]));
          if (!matchesAllowed) {
            violations.push(`Role '${roleName}' is not permitted to write to file: ${file}`);
          }
        }
      }

      if (constitution.compliance?.frameworks) {
        // Framework specific rules if any
      }
    }
  } catch {
    // Fallback
  }

  // Check max files changed
  if (modifiedFiles.length > policies.maxFilesChanged) {
    violations.push(`Too many modified files (${modifiedFiles.length} > ${policies.maxFilesChanged} limit)`);
  }

  // Paths: the agent firewall decides (the one matcher every entry point uses), with protectedPaths as extra
  // deny globs. Anything it does not ALLOW is a violation for an unattended loop.
  if (modifiedFiles.length) {
    let config = {};
    try { config = loadConfig(path.join(cwd, 'gherkin-ai.config.json')); } catch { /* defaults */ }
    const policy = loadFirewallPolicy(cwd, config);
    policy.denyPaths.push(...policies.protectedPaths);
    const firewall = new AgentFirewall(policy);
    const mode = Array.isArray(request) ? 'agent' : request.mode ?? 'agent';
    for (const file of modifiedFiles) {
      const verdict = writeVerdict(firewall, file, mode);
      if (verdict.verdict !== 'ALLOW') violations.push(`Modification of protected path prohibited: ${file} (${verdict.verdict}, ${verdict.rule}: ${verdict.reason})`);
    }
  }

  // Check action human approval requirement
  if (policies.requireHumanApproval) {
    for (const approvalAction of policies.requireHumanApproval) {
      if (action.includes(approvalAction) || modifiedFiles.some(f => f.includes(approvalAction))) {
        requiresHumanApproval = true;
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    requiresHumanApproval
  };
}
