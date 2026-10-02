import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_TOOLS, createMcpServer, invokeTool } from '../../src/mcp/mcp-server';
import { installStdoutGuard } from '../../src/mcp/stdout-guard';
import { configureTelemetry } from '../../src/core/telemetry';

const FEATURE = `Feature: Login
  As a user
  I want to log in
  So that I can use the app

  Scenario: Successful login
    Given a registered user
    When the user submits valid credentials
    Then the user is authenticated
`;

async function connect(perms: { workspace: string; allowWrite: boolean; allowDestructive: boolean }) {
  const { server } = createMcpServer(perms);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP server (least privilege)', () => {
  let workspace: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-mcp-'));
    fs.writeFileSync(path.join(workspace, 'login.feature'), FEATURE);
    process.chdir(workspace);
    configureTelemetry(workspace, {});
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('exposes only read-only tools by default and never exposes credential tools', async () => {
    const client = await connect({ workspace, allowWrite: false, allowDestructive: false });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('parse_gherkin');
    expect(names).toContain('run_cli_lint');
    expect(names).not.toContain('run_cli_generate');
    expect(names).not.toContain('run_cli_verify');
    expect(names).not.toContain('run_cli_login');
    expect(ALL_TOOLS.some(t => t.name === 'run_cli_login')).toBe(false);
  });

  it('enables write tools with allowWrite and destructive tools only with both flags', async () => {
    const writer = await connect({ workspace, allowWrite: true, allowDestructive: false });
    const writerNames = (await writer.listTools()).tools.map(t => t.name);
    expect(writerNames).toContain('run_cli_generate');
    expect(writerNames).not.toContain('run_cli_verify');

    const full = await connect({ workspace, allowWrite: true, allowDestructive: true });
    expect((await full.listTools()).tools.map(t => t.name)).toContain('run_cli_verify');
  });

  it('does not accept a free-form command for verify, nor clear for audit', () => {
    const verify = ALL_TOOLS.find(t => t.name === 'run_cli_verify')!;
    const audit = ALL_TOOLS.find(t => t.name === 'run_cli_audit')!;
    expect(Object.keys(verify.input)).not.toContain('command');
    expect(Object.keys(audit.input)).not.toContain('clear');
  });

  it('calls a safe tool end-to-end through the protocol', async () => {
    const client = await connect({ workspace, allowWrite: false, allowDestructive: false });
    const result = await client.callTool({ name: 'parse_gherkin', arguments: { gherkinText: FEATURE } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).featureName).toContain('Login');
  });

  it('blocks path arguments that escape the workspace (including sibling-prefix tricks)', async () => {
    const lint = ALL_TOOLS.find(t => t.name === 'run_cli_lint')!;
    const perms = { workspace, allowWrite: false, allowDestructive: false };
    for (const feature of ['../outside.feature', '/etc/passwd', `${workspace}-evil/x.feature`]) {
      const res = await invokeTool(lint, { feature }, perms);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('POLICY BLOCK');
    }
  });

  it('refuses a disabled tool even if invoked directly', async () => {
    const generate = ALL_TOOLS.find(t => t.name === 'run_cli_generate')!;
    const res = await invokeTool(generate, { feature: 'login.feature' }, { workspace, allowWrite: false, allowDestructive: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not enabled');
  });

  it('captures command output instead of writing it to the protocol stdout', async () => {
    // Record what reaches the real stdout (the protocol channel) underneath the guard.
    const originalWrite = process.stdout.write;
    const protocolChannel: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      protocolChannel.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const guard = installStdoutGuard();
    try {
      const lint = ALL_TOOLS.find(t => t.name === 'run_cli_lint')!;
      const res = await invokeTool(lint, { feature: 'login.feature' }, { workspace, allowWrite: false, allowDestructive: false }, guard);
      console.log('stray output outside a tool call');
      guard.transportStdout.write('{"jsonrpc":"2.0"}\n');
      await new Promise(resolve => setImmediate(resolve));

      expect(res.content[0].text).toMatch(/login\.feature|score|lint/i);
      expect(protocolChannel).toEqual(['{"jsonrpc":"2.0"}\n']);
    } finally {
      guard.restore();
      process.stdout.write = originalWrite;
    }
  });

  it('writes an audit record for every call, including blocked ones', async () => {
    const lint = ALL_TOOLS.find(t => t.name === 'run_cli_lint')!;
    const perms = { workspace, allowWrite: false, allowDestructive: false };
    await invokeTool(lint, { feature: 'login.feature' }, perms);
    await invokeTool(lint, { feature: '../nope.feature' }, perms);
    const lines = fs.readFileSync(path.join(workspace, '.gherkin-ai', 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.source, l.action, l.status])).toEqual([
      ['mcp', 'mcp:run_cli_lint', expect.stringMatching(/SUCCESS|FAILED/)],
      ['mcp', 'mcp:run_cli_lint', 'BLOCKED']
    ]);
  });
});
