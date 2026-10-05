/* ==========================================================================
   gherkin-ai-cli - 'firewall' command: the agent firewall from the CLI

   ghk firewall check --write <path> | --exec <cmd> | --network <host> | --secret <name> | --tool <name>
   ghk firewall policy [--feature <file>]
   ghk firewall hook   (Claude Code PreToolUse hook: reads the tool call from stdin)

   check exits 0 on ALLOW and 5 (policy denied) on DENY or REQUIRE_APPROVAL.
   ========================================================================== */

import path from 'path';
import { loadConfig } from '../core/config';
import { ExitCode, UsageError } from '../core/errors';
import { AgentFirewall, FirewallDecision, FirewallRequest } from '../core/governance/agent-firewall';
import { emitJson } from '../utils/output';
import { logger } from '../utils/logger';

export interface FirewallCommandOptions {
  write?: string;
  exec?: string;
  network?: string;
  secret?: string;
  tool?: string;
  feature?: string;
  agent?: string;
  json?: boolean;
}

function firewallFor(options: FirewallCommandOptions): AgentFirewall {
  return AgentFirewall.forWorkspace(process.cwd(), loadConfig(), { feature: options.feature });
}

export async function handleFirewallCommand(subcommand: string | undefined, options: FirewallCommandOptions = {}): Promise<void> {
  switch (subcommand ?? 'check') {
    case 'check':
      return check(options);
    case 'policy':
      return showPolicy(options);
    case 'hook':
      return hook(options, await readStdin());
    default:
      throw new UsageError(`Unknown firewall subcommand "${subcommand}".`, { hint: 'Use check, policy or hook.' });
  }
}

function check(options: FirewallCommandOptions): void {
  const requests: FirewallRequest[] = [
    ...(options.write ? [{ kind: 'write' as const, target: options.write }] : []),
    ...(options.exec ? [{ kind: 'execute' as const, target: options.exec }] : []),
    ...(options.network ? [{ kind: 'network' as const, target: options.network }] : []),
    ...(options.secret ? [{ kind: 'secret' as const, target: options.secret }] : []),
    ...(options.tool ? [{ kind: 'tool' as const, target: options.tool }] : [])
  ].map(r => ({ ...r, agent: options.agent ?? 'cli' }));
  if (requests.length === 0) throw new UsageError('Nothing to check.', { hint: 'Pass --write <path>, --exec <command>, --network <host>, --secret <name> or --tool <name>.' });

  const firewall = firewallFor(options);
  const decisions = requests.map(r => firewall.check(r));
  const allowed = decisions.every(d => d.verdict === 'ALLOW');
  if (options.json) {
    emitJson({ allowed, decisions });
  } else {
    for (const d of decisions) {
      const line = `${d.verdict.padEnd(16)} ${d.kind} ${d.target} — ${d.reason} [${d.rule}]`;
      if (d.verdict === 'ALLOW') logger.success(line);
      else logger.warn(line);
    }
  }
  if (!allowed) process.exitCode = ExitCode.POLICY_DENIED;
}

function showPolicy(options: FirewallCommandOptions): void {
  const policy = firewallFor(options).policy;
  if (options.json) {
    emitJson(policy);
    return;
  }
  const list = (title: string, items: string[]) => console.log(`${title}:\n${items.length ? items.map(i => `  ${i}`).join('\n') : '  (none)'}`);
  if (policy.scope) list(`Writes limited to the impact scope of ${policy.scope.feature}`, policy.scope.globs);
  list('Allowed paths (empty = whole workspace)', policy.allowPaths);
  list('Denied paths', policy.denyPaths);
  list('Paths requiring approval', policy.approvalPaths);
  list('Denied commands', policy.denyCommands);
  list('Commands allowed without approval', policy.allowCommands);
  list('Allowed hosts', policy.allowHosts);
  list('Allowed secrets', policy.allowSecrets);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Maps a Claude Code tool call to firewall requests (unknown tools are left to the normal permission flow). */
export function requestsForToolCall(input: HookInput): FirewallRequest[] {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const agent = 'hook:claude-code';
  if (['Write', 'Edit', 'MultiEdit'].includes(tool) && str('file_path')) return [{ kind: 'write', target: str('file_path')!, agent }];
  if (tool === 'NotebookEdit' && str('notebook_path')) return [{ kind: 'write', target: str('notebook_path')!, agent }];
  if (tool === 'Bash' && str('command')) return [{ kind: 'execute', target: str('command')!, agent }];
  if (tool === 'WebFetch' && str('url')) return [{ kind: 'network', target: str('url')!, agent }];
  if (tool === 'Read' && str('file_path')) {
    const base = path.basename(str('file_path')!);
    if (/^\.env|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519)/i.test(base)) return [{ kind: 'secret', target: base, agent }];
  }
  if (tool.startsWith('mcp__')) return [{ kind: 'tool', target: tool.split('__').pop() as string, agent }];
  return [];
}

/**
 * Claude Code PreToolUse hook. DENY → "deny", REQUIRE_APPROVAL → "ask" (the user is prompted),
 * ALLOW → no output, so Claude Code's own permission rules still apply.
 */
function hook(options: FirewallCommandOptions, raw: string): void {
  let input: HookInput = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new UsageError('firewall hook expects the PreToolUse JSON payload on stdin.');
  }
  const firewall = AgentFirewall.forWorkspace(input.cwd ?? process.cwd(), loadConfig(), { feature: options.feature });
  const decisions = requestsForToolCall(input).map(r => firewall.check(r));
  const blocking: FirewallDecision | undefined = decisions.find(d => d.verdict === 'DENY') ?? decisions.find(d => d.verdict === 'REQUIRE_APPROVAL');
  if (!blocking) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: blocking.verdict === 'DENY' ? 'deny' : 'ask',
      permissionDecisionReason: `gherkin-ai firewall: ${blocking.reason} [${blocking.rule}]`
    }
  }) + '\n');
}
