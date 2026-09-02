# AI Skills & Context Extraction

`gherkin-ai` is built to seamlessly integrate with modern AI IDEs and standalone agents. It provides native skills and context anchors to ensure the LLM understands your architecture.

## 1. Context Anchoring (DOM & Data Models)

Generating Gherkin specs in a vacuum produces abstract scenarios that require human intervention to execute. To generate truly executable automation, the AI must understand your application's technical reality.

`gherkin-ai` introduces **Context Extractor**.

Before generating prompts or agent contexts, the CLI scans your workspace for:
- **Data Models:** It parses `prisma/schema.prisma` to extract your entity schemas (up to 5 models).
- **DOM Selectors (Page Object Model):** It scans your `e2e/` folder for `data-test` and `data-testid` attributes.

These assets are injected into the agent's markdown instructions as `[MANDATORY]` directives, forcing the LLM to write tests that match the actual database models and frontend HTML structure.

## 2. Cursor & Windsurf Skills (`ghk skill`)

Modern AI IDEs like [Cursor](https://cursor.sh/) and [Windsurf](https://codeium.com/windsurf) support custom `.cursorrules` and project instructions to steer the built-in AI's behavior.

The `ghk skill` command configures `gherkin-ai` as a native skill inside your IDE.

```bash
ghk skill
```

This command automatically generates a `.cursorrules` file (or appends to an existing one) instructing the IDE's AI to:
1. Always parse `.feature` files to understand business logic.
2. Use `ghk verify --auto-fix` whenever running tests.
3. Automatically run `ghk diff` to ensure DTOs match specs.

By configuring this skill, your AI assistant goes from being a generic coding bot to an enterprise-grade QA engineer constrained by BDD specifications.

## 3. Model Context Protocol (MCP)

For desktop agents like Claude Desktop, `gherkin-ai` operates as a native JSON-RPC Model Context Protocol (MCP) server.

```bash
ghk mcp install
```

This command auto-configures your `claude_desktop_config.json`, exposing tools that the AI can call natively to validate syntax, generate contracts, or read the Step Definitions dictionary in real-time.
