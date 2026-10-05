/* ==========================================================================
   gherkin-ai-cli - MCP tools that write project files (requires_review)
   Enabled only with `mcp.allowWrite: true`.
   ========================================================================== */

import path from 'path';
import { z } from 'zod';
import { generateConstitution } from '../../core/constitution';
import { loadConfig } from '../../core/config';
import { handleInitCommand } from '../../commands/init';
import { handleGenerateCommand } from '../../commands/generate';
import { handleAddCommand } from '../../commands/add';
import { handleCreateCommand } from '../../commands/create';
import { handleAgentLogCommand } from '../../commands/agent-log';
import { handleImplementCommand } from '../../commands/implement';
import { defineTool, ToolSpec } from './types';

const optionalString = (description: string) => z.string().optional().describe(description);

export const projectTools: ToolSpec[] = [
  defineTool<Record<string, never>>({
    name: 'init_enterprise',
    level: 'requires_review',
    description: 'Create the enterprise constitution in .gherkin-ai/ (constitution.yaml, agents/, policies/, templates/, evaluations/).',
    input: {},
    writes: () => ['.gherkin-ai/constitution.yaml'],
    run: async () => {
      generateConstitution({ enterprise: true });
      return { created: ['.gherkin-ai/constitution.yaml', '.gherkin-ai/agents/', '.gherkin-ai/policies/', '.gherkin-ai/templates/', '.gherkin-ai/evaluations/'] };
    }
  }),
  defineTool<Record<string, string | boolean | undefined>>({
    name: 'run_cli_init',
    level: 'requires_review',
    description: 'Initialize gherkin-ai.config.json non-interactively with backend and frontend stack settings.',
    input: {
      projectName: optionalString('Project name.'),
      architecture: optionalString('Software architecture (hexagonal, ddd, clean, cqrs, monolith, api-rest, microservices).'),
      language: optionalString('Backend language.'),
      framework: optionalString('Backend framework.'),
      orm: optionalString('Database ORM / persistence.'),
      database: optionalString('Database engine.'),
      validation: optionalString('Validation library.'),
      messaging: optionalString('Event broker.'),
      testing: optionalString('Testing framework.'),
      frontendFramework: optionalString('Frontend framework.'),
      frontendLanguage: optionalString('Frontend language.'),
      frontendStateManagement: optionalString('Frontend state pattern.'),
      enterprise: z.boolean().optional().describe('Enable enterprise constitution guardrails.')
    },
    writes: () => ['gherkin-ai.config.json'],
    run: async (args) => {
      await handleInitCommand({ ...args, nonInteractive: true, yes: true } as Parameters<typeof handleInitCommand>[0]);
      return { config: loadConfig() };
    }
  }),
  defineTool<{ feature: string; config?: string }>({
    name: 'run_cli_generate',
    level: 'requires_review',
    description: 'Generate contracts, DTO schemas, test fixtures, docker-compose and agent prompts from a feature file.',
    input: { feature: z.string().describe('Path to the .feature file.'), config: optionalString('Path to gherkin-ai.config.json.') },
    pathArgs: ['feature', 'config'],
    writes: () => [loadConfig().outputDir || './'],
    run: async ({ feature, config }) => {
      await handleGenerateCommand({ feature, config, yes: true });
    }
  }),
  defineTool<{ feature: string; target: string }>({
    name: 'run_cli_add',
    level: 'requires_review',
    description: 'Inject contracts and agent prompts into a directory of an existing project.',
    input: { feature: z.string(), target: z.string().describe('Target directory inside the workspace.') },
    pathArgs: ['feature', 'target'],
    writes: ({ target }) => [target],
    run: async ({ feature, target }) => {
      await handleAddCommand({ feature, target, nonInteractive: true, yes: true });
    }
  }),
  defineTool<{ featureName: string; actor?: string; action?: string; outcome?: string; scenarioName?: string; output?: string; target?: string }>({
    name: 'run_cli_create',
    level: 'requires_review',
    description: 'Create a Gherkin .feature specification non-interactively.',
    input: {
      featureName: z.string(),
      actor: optionalString('As a...'),
      action: optionalString('I want to...'),
      outcome: optionalString('So that...'),
      scenarioName: optionalString('Main scenario title.'),
      output: optionalString('Destination path for the .feature file.'),
      target: optionalString('Optional directory to inject contracts into.')
    },
    pathArgs: ['output', 'target'],
    writes: ({ output, target }) => [output, target].filter((p): p is string => Boolean(p)),
    run: async (args) => {
      await handleCreateCommand({ ...args, headless: true, nonInteractive: true, yes: true } as Parameters<typeof handleCreateCommand>[0]);
    }
  }),
  defineTool<{ action: string; feature?: string }>({
    name: 'run_cli_agent_log',
    level: 'requires_review',
    description: 'Record an action executed by the AI agent (append-only).',
    input: { action: z.string().describe('Concrete action taken by the agent.'), feature: optionalString('Feature name or spec path.') },
    writes: () => [path.join('.ghe', 'agent_logs.json')],
    run: async ({ action, feature }) => {
      await handleAgentLogCommand({ action, feature, json: true });
    }
  }),
  defineTool<{ feature: string; docker?: boolean; compact?: boolean }>({
    name: 'run_cli_implement',
    level: 'requires_review',
    description: 'Generate the master implementation prompt and context package for a feature (records an audit entry).',
    input: { feature: z.string(), docker: z.boolean().optional(), compact: z.boolean().optional() },
    pathArgs: ['feature'],
    writes: () => [path.join('.ghe', 'inventory.json')],
    run: async ({ feature, docker, compact }) => {
      await handleImplementCommand({ feature, docker, compact, yes: true });
    }
  })
];
