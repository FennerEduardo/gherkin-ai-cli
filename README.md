# 🥒 `gherkin-ai` CLI & Agentic Verification Engine

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The Closed-Loop Agentic Testing & Orchestration Engine for Enterprise Full-Stack Applications.**
> Turn product requirements into verifiable Gherkin specifications, execute dual-stack implementations (React + Java Spring Boot), and run self-healing agent loops with zero regressions.

---

## 🌟 Strategic Capabilities (`v2.4.0-beta.0`)

While basic AI spec tools only generate text prompts, `gherkin-ai` acts as an **executable contract and verification harness** between Product Intent, AI Agents (Cursor, Claude Code, Windsurf, Antigravity), Code Implementation, and CI/CD Quality Gates:

- 🤖 **True Agentic Engine & Self-Healing (`ghk verify --auto-fix` & `ghk autopilot`)**: Natively connects with LLMs (OpenAI, Anthropic, Ollama). It doesn't just log output; it actively writes and modifies your source code, intercepts test failures, and recursively applies repairs in a true **Closed-Loop**.
- 🌐 **Web Studio UI (`ghk web`)**: Launch a premium local graphical interface to interactively generate your Gherkin specifications, detect your stack, and orchestrate agent prompts visually.
- 🌳 **Official Cucumber AST Parser**: 100% compliant with the Gherkin standard using the official `@cucumber/gherkin` package. Flawlessly parses DataTables, DocStrings, and advanced scenarios for semantic extraction.
- 🔗 **AST Step Definitions Indexer**: Prevents AI hallucinations by statically analyzing your E2E project (Cypress/Playwright/Cucumber-JS) via `ts-morph`, extracting existing `Given/When/Then` steps, and forcing the LLM to reuse them.
- 🛡️ **Semantically Typed Contracts**: Extracts variables straight from your Gherkin data tables (like `@validate:email`) and outputs strictly typed Zod DTOs instead of generic objects.
- ⚙️ **Headless CI/CD Mode**: Fully decoupled non-interactive mode (`ghk create --headless --config spec.json`) designed for frictionless integration into GitHub Actions, Azure DevOps, and automated pipelines.
- 🔌 **Native MCP Server & Cursor Skills (`ghk mcp install` & `ghk skill`)**: Zero-config Model Context Protocol (MCP) server. The new `ghk skill` command injects native Cursor and Windsurf `.cursorrules` to let your IDE automatically invoke Gherkin AI as an internal skill.
- 📦 **Context Engineering & Guardrails Engine (`ghk context`)**: Structurally packages project architecture, conventions, and security policies into `.ghe/`, enforcing strict path protection and agent change limits.
- 🏗️ **DOM & Data Model Anchor**: Automatically extracts `schema.prisma` models and Page Object Model (POM) `data-test` selectors, injecting them into the agent's context to ensure generated tests are grounded in technical reality.
- 🏆 **Dynamic Quality Gate Index (`ghk quality`)**: Measures spec coverage, unit tests, E2E, type safety, and security dynamically by parsing your real test coverage (`coverage-summary.json`) and linter outputs.
- ☕ **Enterprise Java, React, Rust & Go Templates**: Extensive boilerplate support. Scaffolds Spring Boot, Next.js, Rust Axum, Go Fiber, and mobile (Flutter/React Native) architectures out-of-the-box.
- 🕵️ **Interactive Stack & Pattern Detection (`ghk detect`)**: Auto-detects existing brownfield architectures and intelligently injects industry-standard design patterns (e.g., Hooks, CQRS, MVC) into Agent prompts.
- 📡 **Event-Driven & AsyncAPI Support**: Automatically extracts domain events from Gherkin and scaffolds standard `asyncapi.json` contracts.
- 🔍 **True AST Drift Detection (`ghk diff`)**: Validates in CI/CD pipelines if the implemented DTOs and code have drifted from the `.feature` file using native TypeScript AST compilation.

---

## 📥 Installation & Execution (`v2.4.0-beta.0`)

You can use `gherkin-ai` via global `npm` installation, on-demand zero-install `npx`, or as a project local dev dependency:

### Option 1: Global Installation (`npm`)
```bash
npm install -g gherkin-ai
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
npx -y gherkin-ai mcp install

# Run closed-loop verification test harness
npx -y gherkin-ai verify --auto-fix

# Build project context & guardrails (.ghe/)
npx -y gherkin-ai context build

# Calculate feature quality score index
npx -y gherkin-ai quality
```

### Option 3: Local Project Dev Dependency
Add to your project's `devDependencies`:
```bash
npm install --save-dev gherkin-ai
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
ghk mcp install   # (or: npx -y gherkin-ai mcp install)

# 2. Closed-Loop Test Verification with Auto-Fix Loop
ghk verify --auto-fix

# 3. Create a feature using Caveman Mode (skip wizard)
ghk create --caveman

# 4. Auto-detect project stack & suggest design patterns
ghk detect

# 5. Build Project Context & Policy Engine (.ghe/)
ghk context build
```

---

## 📖 Comprehensive Documentation

- [Model Context Protocol (MCP) Integration Guide](docs/MCP_GUIDE.md)
- [Closed-Loop Verification & Auto-Repair Guide](docs/USAGE_GUIDE.md)
- [Architecture & Agent Pipeline Design](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/gherkin-ai-agent-architect)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
