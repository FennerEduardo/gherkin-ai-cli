/* ==========================================================================
   `ghk expose`: the AWS Bedrock AgentCore emitter (PLAN-3.3.0-reverse-plus
   EX-07; Terraform validated and linted by the golden expose-aws, G-E2) and
   the Bedrock reference agent when there are no AWS credentials (EX-08).
   ========================================================================== */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverCapabilities } from '../../src/core/expose/discover';
import { planApproval } from '../../src/core/expose/approve';
import { awsAgentCoreProvider, inlineToolSchema } from '../../src/core/expose/providers/aws-agentcore';
import { overclaimed, providerView } from '../../src/core/expose/providers';
import { awsCredentialsAvailable } from '../../src/core/expose/agent';
import { handleExposeCommand } from '../../src/commands/expose';
import { resetOutputState } from '../../src/utils/output';
import { PROVIDERS } from '../../src/generators/deploy/terraform-versions';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'expose');

function view(name = 'shop') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-aws-'));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  const proposal = discoverCapabilities(dir, { write: false }).manifest;
  return providerView(planApproval(proposal, proposal, undefined, { ids: [], all: true, environments: ['dev'], by: 'Ana', at: '2026-11-03' }).manifest);
}

const options = { environment: 'dev', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', audiences: ['shop-mcp'], region: 'eu-west-1' };

describe('aws-agentcore provider (EX-07)', () => {
  it('emits deterministic Terraform for the gateway, the runtime and least-privilege IAM, with the approved tools inline', () => {
    const v = view();
    const files = awsAgentCoreProvider.emit(v, options);
    expect(awsAgentCoreProvider.emit(v, options)).toEqual(files);
    expect(files.map(f => f.path)).toEqual(['README.md', 'main.tf', 'outputs.tf', 'variables.tf', 'versions.tf']);
    const main = files.find(f => f.path === 'main.tf')!.content;
    for (const fragment of [
      'resource "aws_bedrockagentcore_agent_runtime" "mcp"', 'server_protocol = "MCP"', 'request_header_allowlist = ["Authorization", "traceparent", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]',
      'resource "aws_bedrockagentcore_gateway" "mcp"', 'authorizer_type = "CUSTOM_JWT"', 'search_type  = "SEMANTIC"',
      'supported_versions = length(var.mcp_supported_versions) > 0 ? var.mcp_supported_versions : null',
      'resource "aws_bedrockagentcore_gateway_target" "runtime"', 'jwt_passthrough {}', 'actions   = ["secretsmanager:GetSecretValue"]', 'resources = [var.upstream_secret_arn]',
      'GHK_UPSTREAM_JWT_SECRET_ARN = var.upstream_auth == "mint-hs256" ? var.upstream_secret_arn : ""'
    ]) expect(main).toContain(fragment);
    // the gateway serves exactly the approved tools
    const tools = JSON.parse(JSON.parse(/tools = (".*")\n/.exec(main)![1]));
    expect(tools).toEqual(inlineToolSchema(v));
    expect(tools.map((t: any) => t.name).sort()).toEqual(['cancel_order', 'get_order', 'place_order']);
    // nothing that is not verified: no Cedar policy, no Cognito; no credential value anywhere
    expect(main).not.toMatch(/aws_bedrockagentcore_policy|aws_cognito/);
    expect(files.map(f => f.content).join('\n')).not.toMatch(/secret_string|JWT_SECRET\s*=\s*"/);
    expect(files.find(f => f.path === 'versions.tf')!.content).toContain(`version = "${PROVIDERS.awsAgentCore}"`);
    const vars = files.find(f => f.path === 'variables.tf')!.content;
    expect(vars).toContain('default     = "https://idp.example.com/.well-known/openid-configuration"');
    expect(vars).toContain('default     = ["shop-mcp"]');
    expect(vars).toContain('default     = "eu-west-1"');
  });

  it('declares its controls honestly: native authentication and tool search; per-tool authorization in the runtime', () => {
    const caps = awsAgentCoreProvider.capabilities();
    expect(caps).toMatchObject({ 'inbound-auth': 'native', 'tool-discovery': 'native', 'per-tool-authz': 'runtime', 'tenant-isolation': 'runtime', 'private-network': 'unsupported' });
    const plan = awsAgentCoreProvider.plan(view(), options);
    expect(overclaimed(awsAgentCoreProvider, plan)).toEqual([]);
    expect(plan.warnings.join(' ')).toMatch(/does not emit Cedar/);
    expect(plan.warnings.join(' ')).toMatch(/linux\/arm64/);
    expect(awsAgentCoreProvider.tradeOffs!.join(' ')).toMatch(/cold start/);
    expect(awsAgentCoreProvider.applyCommands).toEqual([['terraform', 'init', '-input=false'], ['terraform', 'apply', '-input=false']]);
  });

  it('banking: financial-critical tools are served by the gateway, and refused by the runtime without a person', () => {
    const plan = awsAgentCoreProvider.plan(view('bank'), options);
    expect(plan.tools).toEqual([expect.objectContaining({ tool: 'execute_payment', effect: 'financial-critical', approval: 'human', controls: expect.objectContaining({ 'human-approval': 'runtime' }) })]);
  });
});

describe('expose test --agent bedrock (EX-08)', () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  afterEach(() => {
    process.env = { ...saved };
    process.chdir(cwd);
    resetOutputState();
  });

  it('detects the AWS credential chain without reading any secret', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-home-'));
    expect(awsCredentialsAvailable({ HOME: home })).toBe(false);
    expect(awsCredentialsAvailable({ HOME: home, AWS_PROFILE: 'dev' })).toBe(true);
    expect(awsCredentialsAvailable({ HOME: home, AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'x' })).toBe(true);
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'config'), '[default]\n');
    expect(awsCredentialsAvailable({ HOME: home })).toBe(true);
  });

  it('is skipped with a message when there are no AWS credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-agent-'));
    fs.cpSync(path.join(FIXTURES, 'shop'), dir, { recursive: true });
    process.chdir(dir);
    await handleExposeCommand('discover', [], {});
    await handleExposeCommand('approve', [], { all: true, env: ['dev'], yes: true, by: 'Ana' });
    for (const k of Object.keys(process.env)) if (k.startsWith('AWS_')) delete process.env[k];
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-home-'));
    process.env.USERPROFILE = process.env.HOME;
    await expect(handleExposeCommand('test', [], {})).rejects.toMatchObject({ exitCode: 2 }); // --url is required
    resetOutputState();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (c: any) => { out.push(String(c)); return true; };
    try {
      await handleExposeCommand('test', [], { url: 'http://127.0.0.1:9/mcp', json: true });
    } finally {
      (process.stdout as any).write = write;
    }
    expect(JSON.parse(out.join(''))).toMatchObject({ skipped: expect.stringMatching(/No AWS credentials/), steps: [] });
  });
});
