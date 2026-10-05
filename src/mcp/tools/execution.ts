/* ==========================================================================
   gherkin-ai-cli - MCP tools that execute commands or let an LLM change code
   (destructive). Enabled only with `mcp.allowWrite: true` AND
   GHK_ALLOW_DESTRUCTIVE=true in the server's environment.

   No tool accepts a free-form command: the test command always comes from
   gherkin-ai.config.json (`testCommand`) or stack detection.
   ========================================================================== */

import { z } from 'zod';
import { handleVerifyCommand } from '../../commands/verify';
import { handleAutopilotCommand } from '../../commands/autopilot';
import { defineTool, ToolSpec } from './types';

async function withDryRun<T>(dryRun: boolean, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GHK_DRY_RUN;
  if (dryRun) process.env.GHK_DRY_RUN = 'true';
  else delete process.env.GHK_DRY_RUN;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GHK_DRY_RUN;
    else process.env.GHK_DRY_RUN = previous;
  }
}

export const executionTools: ToolSpec[] = [
  defineTool<{ autoFix?: boolean; apply?: boolean }>({
    name: 'run_cli_verify',
    level: 'destructive',
    description: 'Run the configured test command (testCommand) in a closed loop. With autoFix the agent proposes repairs; they are only written to disk when apply=true.',
    input: {
      autoFix: z.boolean().optional().describe('Invoke the LLM repair loop on failure.'),
      apply: z.boolean().optional().describe('Write repairs to disk (default: dry-run patch only).')
    },
    run: async ({ autoFix, apply }) => withDryRun(!apply, () => handleVerifyCommand({ autoFix }))
  }),
  defineTool<{ requirement: string }>({
    name: 'run_cli_autopilot',
    level: 'destructive',
    description: 'Generate a specification and scaffolding from a requirement document (dry-run patch unless the server runs with GHK_DRY_RUN=false).',
    input: { requirement: z.string().describe('Path to the requirement markdown file.') },
    pathArgs: ['requirement'],
    run: async ({ requirement }) => withDryRun(process.env.GHK_DRY_RUN !== 'false', () => handleAutopilotCommand({ requirement }))
  })
];
