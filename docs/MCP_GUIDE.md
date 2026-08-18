# 🔌 Model Context Protocol (MCP) Integration Guide (`v2.0.0-beta.1`)

`gherkin-ai` includes a native **Model Context Protocol (MCP)** server enabling AI Coding Agents in **Cursor, Claude Desktop, Antigravity, and Windsurf** to invoke spec generation, AST analysis, dual-stack scaffolding, and context bundlers directly.

---

## ⚡ Quick One-Command Setup (`ghk mcp install`)

Run the automated installer to configure Cursor and Claude Desktop in one step:

```bash
npx -y gherkin-ai@beta mcp install
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
      "args": ["-y", "gherkin-ai@beta", "mcp"]
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
      "args": ["-y", "gherkin-ai@beta", "mcp"]
    }
  }
}
```

---

## 🧰 Exposed MCP Tools

1. `parse_gherkin`: Parses `.feature` specifications into domain AST models.
2. `generate_contracts`: Produces TypeScript, Python (Pydantic), PHP 8.2, Go, and C# DTO contracts.
3. `detect_stack`: Detects workspace tech stack (Spring Boot, Laravel, Rails, NestJS, React).
4. `validate_architecture`: Audits layer boundary isolation.
5. `gherkin_spec_generate`: Synthesizes Gherkin specs with edge-case tables from natural language.
6. `gherkin_verify_diff`: Compares git diff against `.feature` files to highlight missing scenarios.
7. `gherkin_scaffold_bindings`: Scaffolds Playwright or Spring Boot Cucumber step definitions.
8. `gherkin_context_build`: Returns structured `.ghe/` context bundle.
