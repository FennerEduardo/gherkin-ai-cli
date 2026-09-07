/* ==========================================================================
   gherkin-ai-cli - Enterprise Guardrails & Role-Based Enforcement Engine
   ========================================================================== */

import { loadConstitution, getAgentPermissions, Constitution } from './constitution';

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
  protectedPaths: ['infrastructure/**', 'migrations/**', 'config/production*', '.env*', 'secrets/**'],
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
          const matchesAllowed = perms.write.some((perm: string) => 
            matchGlobPattern(file, perm)
          );
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

  // Check protected path patterns
  for (const file of modifiedFiles) {
    for (const protectedPattern of policies.protectedPaths) {
      if (matchGlobPattern(file, protectedPattern)) {
        violations.push(`Modification of protected path prohibited: ${file} (matches '${protectedPattern}')`);
      }
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

function matchGlobPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  if (normalizedPattern === '*' || normalizedPattern === '**') return true;

  const regexPattern = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*(?!\*)/g, '[^/]*');

  const regex = new RegExp(`^${regexPattern}`, 'i');
  return regex.test(normalizedFile);
}
