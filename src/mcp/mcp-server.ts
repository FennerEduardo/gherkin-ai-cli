/* ==========================================================================
   gherkin-ai-cli - Model Context Protocol (MCP) stdio server

   Built on @modelcontextprotocol/sdk. Least privilege by default:
   - safe tools (read-only analysis) are always available,
   - requires_review tools (write project files) need `mcp.allowWrite: true`,
   - destructive tools (run tests, LLM-driven code changes) additionally need
     GHK_ALLOW_DESTRUCTIVE=true in the server environment.
   Tools that are not permitted are not registered at all.

   Every call goes through one middleware: workspace path containment,
   AgentPolicyEngine (.ghkgovernance.yaml) for written paths, stdout capture
   (stdout is the protocol channel) and an audit record.
   ========================================================================== */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { CLI_VERSION } from '../version';
import { loadConfig } from '../core/config';
import { GhkError, PolicyError } from '../core/errors';
import { AgentPolicyEngine } from '../core/governance/agent-policy-engine';
import { setRunContext } from '../core/run-context';
import { getTelemetry } from '../core/telemetry';
import { assertPathInside } from '../utils/path-guard';
import { installStdoutGuard, StdoutGuard } from './stdout-guard';
import { analysisTools } from './tools/analysis';
import { projectTools } from './tools/project';
import { executionTools } from './tools/execution';
import type { ToolSpec } from './tools/types';

export const ALL_TOOLS: ToolSpec[] = [...analysisTools, ...projectTools, ...executionTools];

export interface McpServerOptions {
  workspace?: string;
  allowWrite?: boolean;
  allowDestructive?: boolean;
}

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Narrow view of McpServer.registerTool: its generic overloads are expensive for tsc on ~30 tools.
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: ZodRawShape; annotations?: Record<string, unknown> },
  cb: (args: Record<string, unknown>) => Promise<ToolResult>
) => unknown;

export function resolveMcpPermissions(options: McpServerOptions = {}): Required<McpServerOptions> {
  const workspace = options.workspace ?? process.cwd();
  const config = loadConfig();
  const allowWrite = options.allowWrite ?? config.mcp?.allowWrite === true;
  const allowDestructive = allowWrite && (options.allowDestructive ?? process.env.GHK_ALLOW_DESTRUCTIVE === 'true');
  return { workspace, allowWrite, allowDestructive };
}

export function isToolPermitted(tool: ToolSpec, perms: Required<McpServerOptions>): boolean {
  if (tool.level === 'safe') return true;
  if (tool.level === 'requires_review') return perms.allowWrite;
  return perms.allowDestructive;
}

function summarizeArgs(tool: ToolSpec, args: Record<string, unknown>): string | undefined {
  const paths = (tool.pathArgs ?? []).map(k => args[k]).filter(Boolean);
  return paths.length ? paths.join(', ') : undefined;
}

/** Executes one tool call with all guards. Exported for tests. */
export async function invokeTool(tool: ToolSpec, args: Record<string, unknown>, perms: Required<McpServerOptions>, guard?: Pick<StdoutGuard, 'capture'>): Promise<ToolResult> {
  const telemetry = getTelemetry();
  const started = Date.now();
  const resource = summarizeArgs(tool, args);

  const deny = (message: string): ToolResult => {
    telemetry.recordAudit({ source: 'mcp', action: `mcp:${tool.name}`, status: 'BLOCKED', resource, details: message });
    return { content: [{ type: 'text', text: `[POLICY BLOCK] ${message}` }], isError: true };
  };

  if (!isToolPermitted(tool, perms)) return deny(`Tool '${tool.name}' (${tool.level}) is not enabled on this server.`);

  try {
    for (const key of tool.pathArgs ?? []) {
      const value = args[key];
      if (typeof value === 'string' && value) assertPathInside(perms.workspace, value, `Argument '${key}'`);
    }
    const writes = tool.writes?.(args) ?? [];
    if (writes.length) {
      for (const target of writes) assertPathInside(perms.workspace, target, 'Write target');
      const evaluation = new AgentPolicyEngine(perms.workspace).evaluateFileModifications(writes);
      if (!evaluation.allowed) return deny(`Operation '${tool.name}' violates the agent policy:\n${evaluation.violations.join('\n')}`);
    }
  } catch (err) {
    if (err instanceof PolicyError) return deny(err.message);
    throw err;
  }

  const execute = async () => {
    const result = await tool.run(args, { workspace: perms.workspace });
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exitCode = 0; // a failing gate must not make the long-running server exit non-zero
    return { result, exitCode };
  };
  const captured = guard ? await guard.capture(execute) : await execute().then(r => ({ ok: true as const, result: r, output: '' }), error => ({ ok: false as const, error, output: '' }));

  const parts: string[] = [];
  let isError = false;
  let detail: string | undefined;
  if (captured.ok) {
    if (captured.result.result !== undefined) parts.push(JSON.stringify(captured.result.result, null, 2));
    if (captured.output.trim()) parts.push(captured.output.trim());
    if (captured.result.exitCode !== 0) {
      isError = true;
      detail = `exit code ${captured.result.exitCode}`;
      parts.push(`[exit code ${captured.result.exitCode}]`);
    }
  } else {
    isError = true;
    const error = captured.error;
    detail = error instanceof Error ? error.message : String(error);
    if (captured.output.trim()) parts.push(captured.output.trim());
    parts.push(`Tool execution failed: ${detail}${error instanceof GhkError && error.hint ? `\nHint: ${error.hint}` : ''}`);
  }

  telemetry.recordAudit({ source: 'mcp', action: `mcp:${tool.name}`, status: isError ? 'FAILED' : 'SUCCESS', resource, details: detail });
  telemetry.recordEvent({ eventType: 'MCP_TOOL_CALL', commandName: tool.name, durationMs: Date.now() - started, success: !isError });

  return { content: [{ type: 'text', text: parts.join('\n\n') || 'OK' }], ...(isError ? { isError: true } : {}) };
}

export function createMcpServer(perms: Required<McpServerOptions>, guard?: StdoutGuard): { server: McpServer; registered: string[]; disabled: string[] } {
  const server = new McpServer(
    { name: 'gherkin-ai-mcp', version: CLI_VERSION },
    {
      instructions:
        'gherkin-ai: spec-driven analysis and governance for Gherkin specifications. ' +
        (perms.allowWrite ? 'File-writing tools are enabled. ' : 'Read-only mode: file-writing tools are disabled (mcp.allowWrite). ') +
        (perms.allowDestructive ? 'Test execution and LLM repair tools are enabled.' : 'Test execution and autonomous code changes are disabled.')
    }
  );
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  const registered: string[] = [];
  const disabled: string[] = [];

  for (const tool of ALL_TOOLS) {
    if (!isToolPermitted(tool, perms)) {
      disabled.push(tool.name);
      continue;
    }
    register(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: tool.level === 'safe', destructiveHint: tool.level === 'destructive' }
      },
      args => invokeTool(tool, args, perms, guard)
    );
    registered.push(tool.name);
  }
  return { server, registered, disabled };
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  // Install the guard first: anything printed from here on must not reach the protocol channel.
  const guard = installStdoutGuard();
  setRunContext({ nonInteractive: true, command: 'mcp' });
  const perms = resolveMcpPermissions(options);
  const { server, registered, disabled } = createMcpServer(perms, guard);

  process.stderr.write(`gherkin-ai MCP server v${CLI_VERSION} — workspace ${perms.workspace} — ${registered.length} tools enabled` +
    (disabled.length ? `, ${disabled.length} disabled (${disabled.join(', ')})` : '') + '\n');

  await server.connect(new StdioServerTransport(process.stdin, guard.transportStdout));
}
