# 🥒 `gherkin-ai` v2.0.0-beta.1 Release Notes

> **The Closed-Loop Agentic Testing Engine for Enterprise Full-Stack Applications.**

We are thrilled to announce **`gherkin-ai` v2.0.0-beta.1**, evolving the tool from a Gherkin specification generator into an **Enterprise-Grade Agentic Orchestration & Verification Engine**. 

`gherkin-ai` now acts as the durable contract and verification harness between Product Intent, AI Coding Agents (Cursor, Claude Code, Windsurf, Antigravity), Code Implementation, and CI/CD Quality Gates.

---

## 🌟 Key Highlights & Major Features

### 🔌 1. Native Model Context Protocol (MCP) Server & Auto-Installer (`ghk mcp install`)
- **Zero-Config MCP Stdio JSON-RPC 2.0 Integration**: Native support for Cursor, Claude Desktop, Antigravity, and Windsurf.
- **One-Command Auto-Installer**:
  ```bash
  npx -y gherkin-ai@beta mcp install
  ```
  Automatically configures `.cursor/mcp.json` and `claude_desktop_config.json`.
- **Exposed MCP Tools**: `parse_gherkin`, `generate_contracts`, `detect_stack`, `validate_architecture`, `gherkin_spec_generate`, `gherkin_verify_diff`, `gherkin_scaffold_bindings`, `gherkin_context_build`.

---

### 🔁 2. Closed-Loop Verification & Self-Healing Engine (`ghk verify --auto-fix`)
- **Deterministic Test Execution Sandbox**: Runs local test suites (`npm test`, `vitest`, `playwright`, `mvn test`, `pytest`) programmatically.
- **Containerized Isolation (`--docker`)**: Run verification safely inside isolated Docker containers.
- **Smart Error & Stacktrace Noise Reduction**: Strips compiler and test logs into compact, token-efficient agent context.
- **Iterative Self-Healing Loop**:
  ```bash
  ghk verify --auto-fix --max-retries 3
  ```
  Iteratively feeds failed assertions back to AI agents until all tests pass (`Exit code: 0`).

---

### 📦 3. Context Engineering & Guardrails Policy Engine (`ghk context`)
- **Structured Project Context Directory (`.ghe/`)**:
  - Automatically packages project architecture, coding conventions (`.ghe/conventions.md`), and security policies (`.ghe/security.md`).
- **Enterprise Guardrails Engine**:
  - Enforces path protection limits (`infrastructure/**`, `migrations/**`).
  - Restricts maximum files changed per agent execution cycle.

---

### ☕ ⚛️ 4. Dual-Stack Enterprise Presets (Java Spring Boot & React Playwright)
- **Java Spring Boot Engine Target**:
  - Scaffolds Cucumber-JVM step definitions.
  - Generates GraphQL query/mutation mocks & Testcontainers (PostgreSQL) database fixtures.
- **React Playwright Engine Target**:
  - Scaffolds Playwright E2E and React Testing Library step definitions.
  - Includes MSW (Mock Service Worker) GraphQL interceptors.
  - Enforces accessibility-first UI queries (`getByRole`, `getByLabelText`).

---

### 🚀 5. Autopilot Multi-Agente & Quality Score Gate (`ghk autopilot` / `ghk quality`)
- **`ghk autopilot`**: Decomposes product requirements into sub-agent workflows (Planner, Spec, Developer, Tester, Reviewer) for end-to-end delivery.
- **`ghk quality`**: Measures 6-axis feature compliance (Specification, Unit Tests, Integration Tests, E2E, Type Safety, Security Audit) and enforces 90% threshold gates.
- **Reusable GitHub Action PR Gatekeeper**: `.github/actions/audit/action.yml` for auditing PRs in CI/CD pipelines.

---

## 📦 Installation & Usage

### Install Beta Version via NPM

```bash
npm install -g gherkin-ai@beta
```

or run directly with `npx`:

```bash
npx -y gherkin-ai@beta --help
```

---

## 📊 Summary of CLI Commands

```text
Commands:
  mcp [options] [subcommand]  Start native MCP server or auto-install config (`ghk mcp install`)
  verify|v-loop [options]     Run closed-loop verification test harness with --auto-fix and --docker
  context [subcommand]        Build and package project context into .ghe/
  quality|q                   Calculate feature quality score index and enterprise gate compliance
  autopilot|auto [options]    Run autonomous multi-agent delivery workflow
```

---

## 📄 License & Credits

Distributed under the MIT License. Created by [Fenner Eduardo](https://fennereduardo.com).
