# MCP server guide

`ghk mcp` starts a Model Context Protocol server over stdio. It is built on the official `@modelcontextprotocol/sdk` and works with Claude Code, Claude Desktop, Cursor, Windsurf, VS Code and any other MCP client. The security model is described in [ENTERPRISE.md §7](ENTERPRISE.md#7-mcp-server). This guide covers setup and the tool list.

## Setup

```bash
ghk mcp install
```

`ghk mcp install` writes a version-pinned entry (`npx -y gherkin-ai@<version> mcp`) to `.cursor/mcp.json` in the project and to the Claude Desktop configuration of the current user. For other clients, add the same entry by hand:

```json
{
  "mcpServers": {
    "gherkin-ai": { "command": "npx", "args": ["-y", "gherkin-ai@3.0.0", "mcp"] }
  }
}
```

Claude Code: `claude mcp add gherkin-ai -- npx -y gherkin-ai@3.0.0 mcp`.

Pin the version. An unpinned `npx gherkin-ai` silently changes behavior when a new major version is released, and `ghk upgrade` reports unpinned entries.

## Permissions

| Level | Enabled when | Tools |
|---|---|---|
| safe (read-only) | always | `parse_gherkin`, `build_ir`, `generate_contracts`, `detect_stack`, `validate_architecture`, `lint_specification`, `get_constraints`, `get_business_rules`, `check_convergence`, `calculate_quality`, `scan_security`, `get_constitution`, `ghk_governance_check`, `ghk_impact_analysis`, `run_cli_audit`, `run_cli_agent_log_list`, `run_cli_lint`, `run_cli_converge`, `run_cli_diff` |
| requires_review (writes project files) | `"mcp": { "allowWrite": true }` | `run_cli_init`, `run_cli_generate`, `run_cli_add`, `run_cli_create`, `run_cli_implement`, `run_cli_agent_log`, `init_enterprise` |
| destructive (runs tests, LLM changes code) | `allowWrite` **and** `GHK_ALLOW_DESTRUCTIVE=true` in the server environment | `run_cli_verify`, `run_cli_autopilot` |

Tools that are not enabled are not registered, so the client never sees them. Every call is checked as follows:

- path arguments must stay inside the workspace;
- written paths must be allowed by the [agent firewall](ENTERPRISE.md#14-agent-firewall);
- the call is recorded in the audit trail with `source: "mcp"`.

An organization can lock `mcp.allowWrite` to `false`.

## Governing the agent beyond MCP

MCP only governs the calls an agent makes to gherkin-ai. To apply the same policy to the agent's own edits and shell commands in Claude Code, register `ghk firewall hook` as a `PreToolUse` hook ([ENTERPRISE.md §14](ENTERPRISE.md#14-agent-firewall)).

## Troubleshooting

- **The server exits immediately.** Run `npx -y gherkin-ai@3.0.0 mcp` in a terminal. Configuration errors are printed to stderr with exit code `3`.
- **A tool is missing.** Check its level in the table above. Write tools need `mcp.allowWrite`, and the organization may have locked it.
- **A call returns `[POLICY BLOCK]`.** The message names the rule. `ghk firewall check --write <path>` reproduces the decision from the command line.
