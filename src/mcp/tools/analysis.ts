/* ==========================================================================
   gherkin-ai-cli - MCP read-only tools (safe)
   ========================================================================== */

import { z } from 'zod';
import { parseGherkinText } from '../../core/gherkin-parser';
import { generateContracts } from '../../generators/contracts';
import { detectExistingStack } from '../../core/stack-detector';
import { getArchRule } from '../../core/arch-rules';
import { ARCHITECTURES, loadConfig } from '../../core/config';
import { buildIR, buildSpecificationIR } from '../../core/ir-builder';
import { lintSpecification } from '../../core/specification-linter';
import { calculateConvergence } from '../../core/convergence-engine';
import { calculateDeliveryRisk } from '../../core/risk-engine';
import { loadConstitution, getConstraintsByLevel } from '../../core/constitution';
import { detectPromptInjection, scanContextSecurity } from '../../core/security';
import { SpecHashBaseline } from '../../core/governance/spec-hash-baseline';
import { AgentPolicyEngine } from '../../core/governance/agent-policy-engine';
import { CrossServiceImpactAnalyzer } from '../../core/analysis/cross-service-impact';
import { handleAuditCommand } from '../../commands/audit';
import { handleAgentLogCommand } from '../../commands/agent-log';
import { handleLintCommand } from '../../commands/lint';
import { handleConvergeCommand } from '../../commands/converge';
import { handleDiffCommand } from '../../commands/diff';
import { defineTool, ToolSpec } from './types';

const gherkinText = z.string().describe('Gherkin feature file content.');

export const analysisTools: ToolSpec[] = [
  defineTool<{ gherkinText: string }>({
    name: 'parse_gherkin',
    level: 'safe',
    description: 'Parse Gherkin .feature specification text into domain AST (commands, queries, events, actors).',
    input: { gherkinText },
    run: async ({ gherkinText }) => parseGherkinText(gherkinText)
  }),
  defineTool<{ gherkinText: string; mode?: 'deterministic' | 'hybrid' }>({
    name: 'build_ir',
    level: 'safe',
    description: 'Build the Semantic Intermediate Representation (IR) from Gherkin text: actors, commands, queries, events, state machines, invariants, constraints, traceability and quality indicators.',
    input: { gherkinText, mode: z.enum(['deterministic', 'hybrid']).optional().describe('IR build mode. Default: deterministic.') },
    run: async ({ gherkinText, mode }) => buildIR(parseGherkinText(gherkinText), 'mcp-input.feature', { mode: mode || 'deterministic' })
  }),
  defineTool<{ gherkinText: string; language?: string; architecture?: (typeof ARCHITECTURES)[number] }>({
    name: 'generate_contracts',
    level: 'safe', // returns contracts as text; nothing is written to disk
    description: 'Generate TypeScript, OpenAPI 3.0, AsyncAPI and native language contracts from Gherkin text. Returns the contracts; does not write files.',
    input: {
      gherkinText,
      language: z.string().optional().describe('Target language (typescript, python, php, go, csharp, java, kotlin).'),
      architecture: z.enum(ARCHITECTURES).optional().describe('Architecture style.')
    },
    run: async ({ gherkinText, language, architecture }) => {
      const config = loadConfig();
      if (language) config.stack.language = language;
      if (architecture) config.architecture = architecture;
      const parsed = parseGherkinText(gherkinText);
      return generateContracts(parsed, buildSpecificationIR(parsed, 'mcp-input.feature'), config);
    }
  }),
  defineTool<{ projectDir?: string }>({
    name: 'detect_stack',
    level: 'safe',
    description: 'Auto-detect project tech stack and architecture (defaults to the workspace root).',
    input: { projectDir: z.string().optional().describe('Directory inside the workspace.') },
    pathArgs: ['projectDir'],
    run: async ({ projectDir }, ctx) => detectExistingStack(projectDir || ctx.workspace)
  }),
  defineTool<{ gherkinText: string; architecture?: string }>({
    name: 'validate_architecture',
    level: 'safe',
    description: 'Validate Gherkin AST step coverage and layer import boundary isolation rules.',
    input: { gherkinText, architecture: z.string().optional().describe('Architecture style to validate against.') },
    run: async ({ gherkinText, architecture }) => {
      const parsed = parseGherkinText(gherkinText);
      const arch = getArchRule(architecture || 'hexagonal');
      return {
        featureName: parsed.featureName,
        scenariosCount: parsed.scenarios.length,
        commandsCount: parsed.domainAnalysis.commands.length,
        eventsCount: parsed.domainAnalysis.events.length,
        prohibitedImportsGuard: arch.prohibitedImports,
        passed: parsed.scenarios.length > 0
      };
    }
  }),
  defineTool<{ gherkinText: string; threshold?: number }>({
    name: 'lint_specification',
    level: 'safe',
    description: 'Run the specification linter on Gherkin text. Returns diagnostics with severity, suggestions and a quality score.',
    input: { gherkinText, threshold: z.number().min(0).max(100).optional().describe('Minimum passing score. Default: 70.') },
    run: async ({ gherkinText, threshold }) => lintSpecification(parseGherkinText(gherkinText), 'mcp-input.feature', { threshold: threshold ?? 70 })
  }),
  defineTool<{ level?: 'must' | 'should' | 'may' | 'must-not' }>({
    name: 'get_constraints',
    level: 'safe',
    description: 'Get constraints from the project constitution, optionally filtered by level.',
    input: { level: z.enum(['must', 'should', 'may', 'must-not']).optional() },
    run: async ({ level }) => {
      const constitution = loadConstitution();
      const constraints = level ? getConstraintsByLevel(constitution, level) : constitution?.constraints || [];
      const archConstraints = [
        ...(constitution?.architecture?.required ?? []).map(r => ({ level: 'must', description: r, category: 'architecture' })),
        ...(constitution?.architecture?.forbidden ?? []).map(f => ({ level: 'must-not', description: f, category: 'architecture' }))
      ];
      return {
        constraints: [...(constraints || []), ...archConstraints],
        constitution: constitution
          ? {
              architecture: constitution.architecture,
              security: { dataClassification: constitution.security?.dataClassification, authProvider: constitution.security?.authProvider },
              stack: constitution.stack
            }
          : null
      };
    }
  }),
  defineTool<{ gherkinText: string }>({
    name: 'get_business_rules',
    level: 'safe',
    description: 'Extract business rules, invariants and state machines from Gherkin text.',
    input: { gherkinText },
    run: async ({ gherkinText }) => {
      const ir = buildIR(parseGherkinText(gherkinText), 'mcp-input.feature');
      return { invariants: ir.invariants, stateMachines: ir.stateMachines, commands: ir.commands, events: ir.events, actors: ir.actors, assumptions: ir.assumptions, risks: ir.risks };
    }
  }),
  defineTool<{ gherkinText: string }>({
    name: 'check_convergence',
    level: 'safe',
    description: 'Measure spec-to-implementation convergence across 6 dimensions.',
    input: { gherkinText },
    run: async ({ gherkinText }) => calculateConvergence(parseGherkinText(gherkinText), 'mcp-input.feature')
  }),
  defineTool<Record<string, never>>({
    name: 'calculate_quality',
    level: 'safe',
    description: 'Deployment risk assessment: risk level, blast radius, test strength and security sensitivity.',
    input: {},
    run: async () => calculateDeliveryRisk()
  }),
  defineTool<{ content: string; redact?: boolean }>({
    name: 'scan_security',
    level: 'safe',
    description: 'Scan text for secrets, PII and prompt-injection attempts before sending it to an LLM.',
    input: { content: z.string(), redact: z.boolean().optional().describe('Return a redacted version of the content.') },
    run: async ({ content, redact }) => ({
      promptInjection: detectPromptInjection(content, { checkSecrets: false }),
      contextSecurity: scanContextSecurity(content, { redact: redact || false })
    })
  }),
  defineTool<Record<string, never>>({
    name: 'get_constitution',
    level: 'safe',
    description: 'Read the project constitution (architecture constraints, security policies, stack, agent permissions).',
    input: {},
    run: async () => loadConstitution() || { error: 'No constitution found. Run `ghk init --enterprise` to create one.' }
  }),
  defineTool<{ files: string[] }>({
    name: 'ghk_governance_check',
    level: 'safe',
    description: 'Evaluate files an agent intends to modify against agent policy boundaries and SHA-256 specification baselines.',
    input: { files: z.array(z.string()).describe('Paths of files the agent intends to create or modify.') },
    run: async ({ files }, ctx) => ({
      policy: new AgentPolicyEngine(ctx.workspace).evaluateFileModifications(files),
      baselineDrift: new SpecHashBaseline(ctx.workspace).verifyDrift(files)
    })
  }),
  defineTool<{ gherkinText?: string; changedFiles?: string[] }>({
    name: 'ghk_impact_analysis',
    level: 'safe',
    description: 'Calculate multi-service blast radius across OpenAPI endpoints, AsyncAPI events, DTOs and DB schemas.',
    input: { gherkinText: z.string().optional(), changedFiles: z.array(z.string()).optional() },
    run: async ({ gherkinText, changedFiles }) =>
      new CrossServiceImpactAnalyzer().analyzeImpact(buildIR(parseGherkinText(gherkinText || 'Feature: Impact Analysis'), 'input.feature'), changedFiles || [])
  }),
  defineTool<{ feature?: string }>({
    name: 'run_cli_audit',
    level: 'safe',
    description: 'Query the feature execution audit trail (read-only; the trail cannot be cleared over MCP).',
    input: { feature: z.string().optional().describe('Filter by feature spec or name.') },
    run: async ({ feature }) => {
      await handleAuditCommand({ feature, json: true });
    }
  }),
  defineTool<{ feature?: string }>({
    name: 'run_cli_agent_log_list',
    level: 'safe',
    description: 'List actions recorded by AI agents (read-only).',
    input: { feature: z.string().optional() },
    run: async ({ feature }) => {
      await handleAgentLogCommand({ feature, list: true, json: true });
    }
  }),
  defineTool<{ feature?: string; threshold?: string }>({
    name: 'run_cli_lint',
    level: 'safe',
    description: 'Lint specification files in the workspace (or one feature file).',
    input: { feature: z.string().optional(), threshold: z.string().optional() },
    pathArgs: ['feature'],
    run: async ({ feature, threshold }) => {
      await handleLintCommand({ feature, threshold, json: true });
    }
  }),
  defineTool<{ feature?: string; threshold?: string }>({
    name: 'run_cli_converge',
    level: 'safe',
    description: 'Measure alignment between specifications and implementation.',
    input: { feature: z.string().optional(), threshold: z.string().optional() },
    pathArgs: ['feature'],
    run: async ({ feature, threshold }) => {
      await handleConvergeCommand({ feature, threshold, json: true });
    }
  }),
  defineTool<{ feature: string; target: string }>({
    name: 'run_cli_diff',
    level: 'safe',
    description: 'Detect drift between a Gherkin feature file and a target source file.',
    input: { feature: z.string(), target: z.string() },
    pathArgs: ['feature', 'target'],
    run: async ({ feature, target }) => {
      await handleDiffCommand({ feature, target });
    }
  })
];
