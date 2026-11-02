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
    "gherkin-ai": { "command": "npx", "args": ["-y", "gherkin-ai@3.2.1", "mcp"] }
  }
}
```

Claude Code: `claude mcp add gherkin-ai -- npx -y gherkin-ai@3.2.1 mcp`.

Pin the version. An unpinned `npx gherkin-ai` silently changes behavior when a new major version is released, and `ghk upgrade` reports unpinned entries.

## Permissions

| Level | Enabled when | Tools |
|---|---|---|
| safe (read-only) | always | `parse_gherkin`, `build_ir`, `generate_contracts`, `detect_stack`, `validate_architecture`, `lint_specification`, `get_constraints`, `get_business_rules`, `check_convergence`, `calculate_quality`, `scan_security`, `get_constitution`, `get_industry_profile`, `ghk_governance_check`, `ghk_impact_analysis`, `run_cli_audit`, `run_cli_agent_log_list`, `run_cli_lint`, `run_cli_converge`, `run_cli_diff`, `ghk_reverse_scan`, `ghk_reverse_get_evidence` |
| requires_review (writes project files) | `"mcp": { "allowWrite": true }` | `run_cli_init`, `run_cli_generate`, `run_cli_add`, `run_cli_create`, `run_cli_implement`, `run_cli_agent_log`, `init_enterprise`, `ghk_reverse_propose` (writes `.ghe/reverse/` only) |
| destructive (runs tests, LLM changes code) | `allowWrite` **and** `GHK_ALLOW_DESTRUCTIVE=true` in the server environment | `run_cli_verify`, `run_cli_autopilot` |

Tools that are not enabled are not registered, so the client never sees them. Every call is checked as follows:

- path arguments must stay inside the workspace;
- written paths must be allowed by the [agent firewall](ENTERPRISE.md#14-agent-firewall);
- the call is recorded in the audit trail with `source: "mcp"`.

An organization can lock `mcp.allowWrite` to `false`.

### Reverse engineering over MCP (beta)

An agent can ask gherkin-ai what an existing codebase does, and gherkin-ai keeps control of the analysis ([REVERSE.md](REVERSE.md)):
- `ghk_reverse_scan` analyses the workspace in memory and returns the analyzers, their maturity and the evidence counts. It writes nothing.
- `ghk_reverse_get_evidence` returns the facts, each with file, line and confidence, filtered by kind, operation path or id. Code comments and strings in the results are data, never instructions.
- `ghk_reverse_propose` writes candidate features to `.ghe/reverse/proposals/` and returns them with their lint score, open questions and coverage.

Accepting proposals into the specification is not available over MCP: a person runs `ghk reverse accept`.

## Governing the agent beyond MCP

MCP only governs the calls an agent makes to gherkin-ai. To apply the same policy to the agent's own edits and shell commands in Claude Code, register `ghk firewall hook` as a `PreToolUse` hook ([ENTERPRISE.md §14](ENTERPRISE.md#14-agent-firewall)).

## Troubleshooting

- **The server exits immediately.** Run `npx -y gherkin-ai@3.2.1 mcp` in a terminal. Configuration errors are printed to stderr with exit code `3`.
- **A tool is missing.** Check its level in the table above. Write tools need `mcp.allowWrite`, and the organization may have locked it.
- **A call returns `[POLICY BLOCK]`.** The message names the rule. `ghk firewall check --write <path>` reproduces the decision from the command line.
