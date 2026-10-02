/* ==========================================================================
   gherkin-ai-cli - MCP tool specification
   ========================================================================== */

import type { ZodRawShape } from 'zod';
import type { OperationSafetyLevel } from '../mcp-operation-safety';

export interface ToolContext {
  /** Workspace root the server was started in; every path argument must resolve inside it. */
  workspace: string;
}

export interface ToolSpec<Args = Record<string, unknown>> {
  name: string;
  description: string;
  level: OperationSafetyLevel;
  input: ZodRawShape;
  /** Argument names holding file/dir paths that must stay inside the workspace. */
  pathArgs?: string[];
  /** Paths this call will create or modify, checked against the agent policy (.ghkgovernance.yaml). */
  writes?: (args: Args) => string[];
  /** Returns a JSON-serializable result, or nothing when the command's printed output is the result. */
  run(args: Args, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<Args>(spec: ToolSpec<Args>): ToolSpec<Record<string, unknown>> {
  return spec as unknown as ToolSpec<Record<string, unknown>>;
}
