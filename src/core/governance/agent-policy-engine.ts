/* ==========================================================================
   gherkin-ai-cli - Agent Policy Engine ("Rieles Claros" Guardrails)

   Deprecated: kept for the MCP `ghk_governance_check` tool and the legacy
   .ghkgovernance.yaml. Its decisions come from the agent firewall (same
   rules and matcher as every other entry point); migrate the YAML keys to
   policy.firewall in gherkin-ai.config.json.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { AgentFirewall, BUILTIN_APPROVAL_PATHS, BUILTIN_DENY_PATHS } from './agent-firewall';
import { firstMatch } from '../../utils/glob';

export interface GovernancePolicyConfig {
  version: string;
  allowedPaths: string[];
  protectedPaths: string[];
  maxFilesPerTask?: number;
  prohibitedImports?: Record<string, string[]>;
  requireHumanApprovalOn?: string[];
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  violations: string[];
  requiresApproval: boolean;
  approvalReasons: string[];
}

export class AgentPolicyEngine {
  private config: GovernancePolicyConfig;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string, customConfig?: Partial<GovernancePolicyConfig>) {
    this.workspaceDir = path.resolve(workspaceDir);
    const configPath = path.join(workspaceDir, '.ghkgovernance.yaml');
    if (customConfig) {
      this.config = this.normalizeConfig(customConfig);
    } else if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = YAML.parse(raw);
        this.config = this.normalizeConfig(parsed);
      } catch {
        this.config = this.getDefaultPolicy();
      }
    } else {
      this.config = this.getDefaultPolicy();
    }
  }

  private getDefaultPolicy(): GovernancePolicyConfig {
    return {
      version: '1.0',
      allowedPaths: ['src/**/*', 'specs/**/*', 'tests/**/*', 'generated-specs/**/*'],
      protectedPaths: ['.env*', '**/secrets.*', 'node_modules/**', '.git/**'],
      maxFilesPerTask: 15,
      requireHumanApprovalOn: ['schema.prisma', 'migrations/**', '**/security.ts']
    };
  }

  private normalizeConfig(cfg: Partial<GovernancePolicyConfig>): GovernancePolicyConfig {
    const defaults = this.getDefaultPolicy();
    return {
      version: cfg.version || defaults.version,
      allowedPaths: cfg.allowedPaths || defaults.allowedPaths,
      protectedPaths: cfg.protectedPaths || defaults.protectedPaths,
      maxFilesPerTask: cfg.maxFilesPerTask || defaults.maxFilesPerTask,
      prohibitedImports: cfg.prohibitedImports || defaults.prohibitedImports,
      requireHumanApprovalOn: cfg.requireHumanApprovalOn || defaults.requireHumanApprovalOn
    };
  }

  /**
   * Evaluates if a list of files to modify violates governance policies
   */
  public evaluateFileModifications(targetFiles: string[]): PolicyEvaluationResult {
    const violations: string[] = [];
    const approvalReasons: string[] = [];

    // 1. Check max files per task
    if (this.config.maxFilesPerTask && targetFiles.length > this.config.maxFilesPerTask) {
      violations.push(`Task modifies ${targetFiles.length} files, exceeding limit of ${this.config.maxFilesPerTask}.`);
    }

    // Same decision point and glob matcher as the agent firewall (M-01): the built-in deny list (secrets,
    // keys, .git) always applies, this policy's protectedPaths and allowedPaths on top.
    const firewall = new AgentFirewall({
      workspace: this.workspaceDir,
      allowPaths: this.config.allowedPaths,
      denyPaths: [...BUILTIN_DENY_PATHS, ...this.config.protectedPaths],
      approvalPaths: [],
      allowCommands: [],
      denyCommands: [],
      allowHosts: [],
      allowSecrets: []
    });
    for (const file of targetFiles) {
      const normalized = file.replace(/\\/g, '/');
      const decision = firewall.evaluate({ kind: 'write', target: normalized });
      if (decision.verdict === 'DENY') violations.push(`File '${file}' is not writable by policy (${decision.rule}).`);

      const approval = firstMatch(normalized, [...BUILTIN_APPROVAL_PATHS, ...(this.config.requireHumanApprovalOn || [])]);
      if (approval) approvalReasons.push(`Modification to '${file}' matches approval policy (${approval}).`);
    }

    return {
      allowed: violations.length === 0,
      violations,
      requiresApproval: approvalReasons.length > 0,
      approvalReasons
    };
  }
}
