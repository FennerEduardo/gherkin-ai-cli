# 🔌 Model Context Protocol (MCP) Integration Guide (`v2.6.0` Stable)

`gherkin-ai` includes a native **Model Context Protocol (MCP)** server enabling AI Coding Agents in **Cursor, Claude Desktop, Antigravity, and Windsurf** to invoke spec generation, AST analysis, dual-stack scaffolding, and context bundlers directly.

---

## ⚡ Quick One-Command Setup (`ghk mcp install`)

Run the automated installer to configure Cursor and Claude Desktop in one step:

```bash
npx -y gherkin-ai mcp install
```

This will automatically create or update:
- Local Cursor Config: `.cursor/mcp.json`
- Global Claude Desktop Config: `claude_desktop_config.json`

---

## 🛠 Manual Configuration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai", "mcp"]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "gherkin-ai": {
      "command": "npx",
      "args": ["-y", "gherkin-ai", "mcp"]
    }
  }
}
```

---

## 🧰 Exposed MCP Tools

1. `parse_gherkin`: Parses `.feature` specifications into domain AST models.
2. `build_ir`: Builds Semantic Intermediate Representation (IR) from Gherkin.
3. `generate_contracts`: Produces TypeScript, Python (Pydantic), PHP 8.2, Go, and C# DTO contracts.
4. `detect_stack`: Detects workspace tech stack (Spring Boot, Laravel, Rails, NestJS, React).
5. `validate_architecture`: Audits layer boundary isolation.
6. `lint_specification`: Runs 14 specification linting rules on Gherkin.
7. `get_constraints`: Fetches architecture & security constraints from constitution.
8. `get_business_rules`: Extracts invariants and state machines.
9. `check_convergence`: Measures spec-to-implementation alignment.
10. `calculate_quality`: Computes overall quality scorecard.
11. `scan_security`: Checks for prompt injection and secrets.
