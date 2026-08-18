/* ==========================================================================
   gherkin-ai-cli - Enterprise Guardrails & Policy Enforcement Engine
   ========================================================================== */

export interface GuardrailPolicies {
  requireTests: boolean;
  requireTypecheck: boolean;
  maxFilesChanged: number;
  protectedPaths: string[];
  requireHumanApproval: string[];
}

export const DEFAULT_GUARDRAILS: GuardrailPolicies = {
  requireTests: true,
  requireTypecheck: true,
  maxFilesChanged: 30,
  protectedPaths: ['infrastructure/**', 'migrations/**', 'config/production*'],
  requireHumanApproval: ['database-migration', 'auth-change']
};

export interface GuardrailValidationResult {
  allowed: boolean;
  violations: string[];
}

export function validateGuardrails(
  modifiedFiles: string[],
  policies: GuardrailPolicies = DEFAULT_GUARDRAILS
): GuardrailValidationResult {
  const violations: string[] = [];

  if (modifiedFiles.length > policies.maxFilesChanged) {
    violations.push(`Too many modified files (${modifiedFiles.length} > ${policies.maxFilesChanged} limit)`);
  }

  for (const file of modifiedFiles) {
    for (const protectedPattern of policies.protectedPaths) {
      const cleanPattern = protectedPattern.replace('/**', '');
      if (file.startsWith(cleanPattern)) {
        violations.push(`Modification of protected path prohibited: ${file}`);
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations
  };
}
