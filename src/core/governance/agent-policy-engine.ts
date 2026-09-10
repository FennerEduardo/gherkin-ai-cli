/* ==========================================================================
   gherkin-ai-cli - Agent Policy Engine ("Rieles Claros" Guardrails)
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

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

  constructor(workspaceDir: string, customConfig?: Partial<GovernancePolicyConfig>) {
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

    for (const file of targetFiles) {
      const normalized = file.replace(/\\/g, '/');

      // 2. Check protected paths
      for (const protectedPattern of this.config.protectedPaths) {
        if (this.matchGlobLike(normalized, protectedPattern)) {
          violations.push(`File '${file}' is protected by policy (${protectedPattern}).`);
        }
      }

      // 3. Check human approval requirement
      for (const approvalPattern of (this.config.requireHumanApprovalOn || [])) {
        if (this.matchGlobLike(normalized, approvalPattern)) {
          approvalReasons.push(`Modification to '${file}' matches approval policy (${approvalPattern}).`);
        }
      }
    }

    return {
      allowed: violations.length === 0,
      violations,
      requiresApproval: approvalReasons.length > 0,
      approvalReasons
    };
  }

  private matchGlobLike(filePath: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${regexPattern}$`, 'i').test(filePath) || filePath.includes(pattern.replace(/\*/g, ''));
  }
}
