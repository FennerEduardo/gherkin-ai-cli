# IDE skills and context extraction

gherkin-ai gives IDE agents three things: the project's real context in the generated prompts, a rules file that tells the agent how to use the CLI, and an MCP server.

## 1. Context in the generated prompts

Before it writes the agent prompts, `ghk generate` reads the workspace for context the agent would otherwise guess:

- **Data models.** Up to five models from `prisma/schema.prisma`.
- **DOM selectors.** `data-test` and `data-testid` attributes in the files under `e2e/`, for page objects.
- **Step definitions.** The Cucumber step definitions written or edited by people (see [ast-step-indexer.md](ast-step-indexer.md)).

They are added to the prompts as `[MANDATORY]` sections, so the agent writes tests against the actual models, selectors and steps.

## 2. Rules file for the IDE (`ghk skill`)

```bash
ghk skill
```

It asks for the target and writes the gherkin-ai rules there:

| Target | File |
|---|---|
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` |

An existing file keeps its content: the rules are appended, and running `ghk skill` again replaces only the gherkin-ai block. The rules tell the agent to:

- read `gherkin-ai.config.json`, the constitution and the industry context before coding;
- check its scope with `ghk firewall policy` and leave approval paths to people;
- lint the feature, use `ghk lint --explain-ir` and tags for generic names;
- generate, read `ghk implement`, implement the pending steps, and leave `.ghk-new` files for the developer;
- verify with `ghk verify`, `ghk converge` and `ghk risk`.

`ghk skill` can also register the MCP server in the IDE instead of writing rules.

## 3. MCP server

```bash
ghk mcp install
```

It registers a version-pinned, read-only MCP server in `.cursor/mcp.json` and in the Claude Desktop configuration. The tools, their safety levels and the setup for other clients are in [MCP_GUIDE.md](MCP_GUIDE.md).
