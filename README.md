# 🥒 `gherkin-ai` CLI & Agentic Verification Engine

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The Closed-Loop Agentic Testing & Orchestration Engine for Enterprise Full-Stack Applications.**
> Turn product requirements into verifiable Gherkin specifications, execute dual-stack implementations (React + Java Spring Boot), and run self-healing agent loops with zero regressions.

---

## 🌟 Strategic Capabilities (`v2.0.0-beta.1`)

While basic AI spec tools only generate text prompts, `gherkin-ai` acts as an **executable contract and verification harness** between Product Intent, AI Agents (Cursor, Claude Code, Windsurf, Antigravity), Code Implementation, and CI/CD Quality Gates:

- 🔌 **Native MCP Server & Auto-Installer (`ghk mcp install`)**: Zero-config Model Context Protocol (MCP) JSON-RPC 2.0 stdio server connecting directly with Cursor (`.cursor/mcp.json`) and Claude Desktop (`claude_desktop_config.json`).
- 🔁 **Closed-Loop Verification & Self-Healing (`ghk verify --auto-fix`)**: Programmatically executes test suites (`npm test`, `vitest`, `playwright`, `mvn test`), parses compiler/test stacktraces into targeted AI context, and iteratively repairs code until assertions pass.
- 📦 **Context Engineering & Guardrails Engine (`ghk context`)**: Structurally packages project architecture, conventions, and security policies into `.ghe/`, enforcing strict path protection and agent change limits.
- ☕ **Enterprise Java & GraphQL Presets**: Scaffolds Cucumber-JVM, Spring Boot, GraphQL queries/mutations, and Testcontainers (PostgreSQL) fixtures.
- ⚛️ **Modern React & Playwright Presets**: Scaffolds Playwright E2E and React Testing Library step definitions with MSW GraphQL mocks and accessibility-first selectors (`getByRole`).
- 🚀 **Autopilot Multi-Agent Delivery (`ghk autopilot`)**: Decomposes product requirements into sub-agent workflows (Planner, Spec, Developer, Tester, Reviewer) and generates ready-to-merge Pull Requests.
- 📊 **Enterprise Quality Gate Index (`ghk quality`)**: Measures spec coverage, unit tests, E2E, type safety, and security score before merging.

---

## 📥 Installation & Execution (`v2.0.0-beta.1`)

You can use `gherkin-ai` via global `npm` installation, on-demand zero-install `npx`, or as a project local dev dependency:

### Option 1: Global Installation (`npm`)
```bash
npm install -g gherkin-ai@beta
```
Once installed globally, you can use `ghk` or `gherkin-ai` CLI commands directly:
```bash
ghk mcp install
ghk verify --auto-fix
ghk context build
ghk quality
```

### Option 2: Zero-Install On-Demand (`npx`)
Run any `gherkin-ai` command instantly without global installation:
```bash
# Auto-install MCP server for Cursor & Claude Desktop
npx -y gherkin-ai@beta mcp install

# Run closed-loop verification test harness
npx -y gherkin-ai@beta verify --auto-fix

# Build project context & guardrails (.ghe/)
npx -y gherkin-ai@beta context build

# Calculate feature quality score index
npx -y gherkin-ai@beta quality
```

### Option 3: Local Project Dev Dependency
Add to your project's `devDependencies`:
```bash
npm install --save-dev gherkin-ai@beta
```
Then invoke via `npx` or add scripts to your `package.json`:
```json
{
  "scripts": {
    "test:verify": "ghk verify --auto-fix",
    "quality:check": "ghk quality"
  }
}
```

---

## 🚀 Quick Start Commands

```bash
# 1. Setup MCP Server for Cursor & Claude Desktop
ghk mcp install   # (or: npx -y gherkin-ai@beta mcp install)

# 2. Closed-Loop Test Verification with Auto-Fix Loop
ghk verify --auto-fix

# 3. Run inside an isolated Docker sandbox container
ghk verify --auto-fix --docker

# 4. Build Project Context & Policy Engine (.ghe/)
ghk context build

# 5. Calculate Feature Quality Score & PR Gate Compliance
ghk quality
```

---

## 📖 Comprehensive Documentation

- [Model Context Protocol (MCP) Integration Guide](docs/MCP_GUIDE.md)
- [Closed-Loop Verification & Auto-Repair Guide](docs/USAGE_GUIDE.md)
- [Architecture & Agent Pipeline Design](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/GherkinIATool/)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
