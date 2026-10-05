import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Black-box contract tests against the built CLI (run `npm run build` first; CI does).
 * They assert what automation depends on: exit codes and a single JSON document on stdout.
 */
const BIN = path.resolve(__dirname, '../../bin/gherkin-ai.js');
const DIST = path.resolve(__dirname, '../../dist/index.js');

const FEATURE = `Feature: Checkout
  As a customer
  I want to pay for my cart
  So that I receive my order

  Scenario: Successful payment
    Given a cart with 2 items
    When the customer pays with a valid card
    Then the order is confirmed
`;

describe.skipIf(!fs.existsSync(DIST))('CLI contract (built binary)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const res = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-cli-'));
    fs.mkdirSync(path.join(dir, 'specs'));
    fs.writeFileSync(path.join(dir, 'specs', 'checkout.feature'), FEATURE);
    fs.writeFileSync(path.join(dir, 'gherkin-ai.config.json'), JSON.stringify({ projectName: 'contract-test', architecture: 'hexagonal', specDir: 'specs' }));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GHK_|LLM_|OPENAI|ANTHROPIC|GEMINI|AZURE_OPENAI|CI$)/.test(k)));
    env = {
      ...clean,
      NO_COLOR: '1',
      GHK_NON_INTERACTIVE: 'true',
      GHK_USER_CONFIG: path.join(dir, 'user-config.json'),
      GHK_ORG_CONFIG: path.join(dir, 'no-org-config.json')
    };
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('--help and --version exit 0 without prompting', () => {
    expect(run(['--help']).code).toBe(0);
    const version = run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('unknown options exit with the usage code (2)', () => {
    expect(run(['lint', '--definitely-not-a-flag']).code).toBe(2);
  });

  it.each([
    ['lint', ['lint', '--json']],
    ['global --json before the command', ['--json', 'lint']],
    ['converge', ['converge', '--json']],
    ['config validate', ['config', 'validate', '--json']],
    ['audit', ['audit', '--json']],
    ['a command without structured output (envelope)', ['--json', 'context']]
  ])('%s prints exactly one JSON document on stdout', (_label, args) => {
    const res = run(args);
    expect(() => JSON.parse(res.stdout), `stdout was:\n${res.stdout}\nstderr:\n${res.stderr}`).not.toThrow();
  });

  it('reports invalid configuration with exit code 3 and a JSON error', () => {
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-bad-'));
    fs.writeFileSync(path.join(bad, 'gherkin-ai.config.json'), JSON.stringify({ architecture: 'spaghetti' }));
    const res = spawnSync(process.execPath, [BIN, 'lint', '--json'], { cwd: bad, env, encoding: 'utf8' });
    expect(res.status).toBe(3);
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: false, error: { type: 'ConfigError', exitCode: 3 } });
  });

  it('auth status explains a missing key without leaking secrets', () => {
    fs.writeFileSync(env.GHK_USER_CONFIG!, JSON.stringify({ llm: { provider: 'anthropic' } }));
    const res = run(['auth', 'status', '--json'], { OPENAI_API_KEY: 'sk-should-not-be-used-for-anthropic-000000000000' });
    const status = JSON.parse(res.stdout);
    expect(status).toMatchObject({ ok: false });
    expect(res.code).toBe(3);
    expect(res.stdout + res.stderr).not.toContain('sk-should-not-be-used');
    fs.rmSync(env.GHK_USER_CONFIG!);
  });

  it('refuses a missing --project directory instead of creating it', () => {
    const res = run(['--project', 'does-not-exist', 'lint']);
    expect(res.code).toBe(2);
    expect(fs.existsSync(path.join(dir, 'does-not-exist'))).toBe(false);
  });

  it('serves MCP over stdio from any directory without corrupting the protocol', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: dir, env: env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map(t => t.name);
      expect(tools).toContain('run_cli_lint');
      expect(tools).not.toContain('run_cli_verify');
      // run_cli_lint prints with console.log in-process; the call must still round-trip cleanly.
      const result = await client.callTool({ name: 'run_cli_lint', arguments: { feature: 'specs/checkout.feature' } });
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(/checkout/i);
      const second = await client.callTool({ name: 'parse_gherkin', arguments: { gherkinText: FEATURE } });
      expect(second.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 30_000);

  it('records command telemetry locally with the exit code', () => {
    run(['lint']);
    const events = fs.readFileSync(path.join(dir, '.gherkin-ai', 'telemetry.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(events.some(e => e.eventType === 'COMMAND_EXECUTION' && e.commandName === 'lint' && typeof e.exitCode === 'number')).toBe(true);
  });
});
