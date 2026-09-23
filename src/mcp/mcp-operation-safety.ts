/* ==========================================================================
   gherkin-ai-cli - MCP Operation Safety Classification
   
   Classifies MCP tools into safety tiers to enforce human confirmation
   for destructive operations. Applied centrally by the MCP server.
   ========================================================================== */

export type OperationSafetyLevel = 'safe' | 'requires_review' | 'destructive';

export interface OperationClassification {
  level: OperationSafetyLevel;
  description: string;
  requiresHumanApproval: boolean;
}

/**
 * Central classification of all MCP tool operations by safety level.
 * 
 * - safe: Read-only or analysis tools. No filesystem or code modifications.
 * - requires_review: Generates files or modifies configuration. Should show diff.
 * - destructive: Modifies source code autonomously, executes commands, or writes credentials.
 */
const TOOL_SAFETY_MAP: Record<string, OperationSafetyLevel> = {
  // === SAFE: Read-only, analysis, query tools ===
  'parse_gherkin': 'safe',
  'build_ir': 'safe',
  'detect_stack': 'safe',
  'validate_architecture': 'safe',
  'lint_specification': 'safe',
  'get_constraints': 'safe',
  'get_business_rules': 'safe',
  'check_convergence': 'safe',
  'calculate_quality': 'safe',
  'scan_security': 'safe',
  'get_constitution': 'safe',
  'ghk_governance_check': 'safe',
  'ghk_impact_analysis': 'safe',
  'run_cli_audit': 'safe',
  'run_cli_agent_log': 'safe',
  'run_cli_lint': 'safe',
  'run_cli_converge': 'safe',
  'run_cli_diff': 'safe',

  // === REQUIRES REVIEW: Generates files, modifies project ===
  'generate_contracts': 'requires_review',
  'run_cli_generate': 'requires_review',
  'run_cli_init': 'requires_review',
  'run_cli_create': 'requires_review',
  'run_cli_add': 'requires_review',
  'run_cli_implement': 'requires_review',
  'init_enterprise': 'requires_review',
  'run_cli_login': 'requires_review',

  // === DESTRUCTIVE: Autonomous code modification, execution ===
  'run_cli_verify': 'destructive',
  'run_cli_autopilot': 'destructive',
};

export function classifyOperation(toolName: string): OperationClassification {
  const level = TOOL_SAFETY_MAP[toolName] || 'destructive'; // Default to most restrictive

  return {
    level,
    description: getDescription(level),
    requiresHumanApproval: level === 'destructive',
  };
}

function getDescription(level: OperationSafetyLevel): string {
  switch (level) {
    case 'safe':
      return 'Read-only analysis. No modifications to filesystem or code.';
    case 'requires_review':
      return 'Generates or modifies files. Review output before committing.';
    case 'destructive':
      return 'CAUTION: Autonomously modifies source code or executes commands. Requires human supervision.';
  }
}

/**
 * Formats a safety warning for the MCP response when a destructive tool is called.
 */
export function formatSafetyWarning(toolName: string): string {
  const classification = classifyOperation(toolName);
  if (classification.level === 'destructive') {
    return `\n⚠️  SAFETY WARNING: Tool '${toolName}' is classified as DESTRUCTIVE.\n` +
      `   ${classification.description}\n` +
      `   This operation should be run with --dry-run first and requires human supervision.\n` +
      `   All changes will be logged to .gherkin-ai/logs/ for audit.\n`;
  }
  if (classification.level === 'requires_review') {
    return `\nℹ️  Tool '${toolName}' generates or modifies files. Review output before committing.\n`;
  }
  return '';
}

/**
 * Returns the complete list of tool classifications for documentation/introspection.
 */
export function getAllToolClassifications(): Record<string, OperationClassification> {
  const result: Record<string, OperationClassification> = {};
  for (const [tool, level] of Object.entries(TOOL_SAFETY_MAP)) {
    result[tool] = classifyOperation(tool);
  }
  return result;
}
