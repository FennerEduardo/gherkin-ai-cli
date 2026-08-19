# 🏗️ `gherkin-ai` CLI Architecture & Agent Pipeline Design (`v2.0.0-beta.1`)

This document details the internal design, closed-loop verification engine, MCP protocol integration, guardrails policy engine, and multi-agent delivery orchestration in `gherkin-ai`.

---

## 1. System Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRODUCT INPUT                                  │
│             (User Story / GraphQL Schema / JIRA Acceptance Spec)            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHASE 1: AGENTIC SPEC GENERATOR (MCP)                    │
│   • Semantic Boundary Edge-Case Synthesis                                    │
│   • Multi-Persona Scenario Splitting (Frontend UI vs. Backend API)          │
│   • Model Context Protocol (MCP) Stdio JSON-RPC 2.0 Interface               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              PHASE 2: DUAL-TARGET STEP BINDING & SCAFFOLDING                │
│    ┌───────────────────────────────┐     ┌──────────────────────────────┐   │
│    │     Java / Spring Backend     │     │     React / Playwright UI    │   │
│    │ Cucumber-JVM + REST / GraphQL │     │  Component & E2E Step Binds  │   │
│    └───────────────────────────────┘     └──────────────────────────────┘   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 PHASE 3: CLOSED-LOOP VERIFICATION HARNESS                   │
│   1. Agent executes implementation                                          │
│   2. Test runner fires (JUnit 5 / Playwright CLI / Vitest / Local / Docker) │
│   3. Build/Runtime feedback captured into structured agent context          │
│   4. Self-Healing iteration until all assertions pass (Exit code: 0)        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 PHASE 4: ENTERPRISE CI/CD & MULTI-AGENT SWARM               │
│   • Sub-agent parallel feature execution (`ghk autopilot`)                  │
│   • GitHub Action PR Gatekeeper & Quality Score (`ghk quality`)             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Components

### 2.1 Closed-Loop Verification Harness (`src/core/execution-sandbox.ts` & `src/commands/verify.ts`)
Executes local test harnesses deterministically. Supports:
- Native system process execution (npm test, vitest, pytest, maven, gradle, go test).
- Containerized execution inside isolated Docker sandboxes (`--docker`).
- Smart stack trace parsing and context noise reduction (`src/core/error-parser.ts`).

### 2.2 Model Context Protocol (MCP) Server (`src/mcp/mcp-server.ts` & `src/mcp/mcp-installer.ts`)
Exposes stdio JSON-RPC 2.0 tools for Cursor, Claude Desktop, Antigravity, and Windsurf:
- `gherkin_spec_generate`
- `gherkin_verify_diff`
- `gherkin_scaffold_bindings`
- `gherkin_context_build`
- Auto-installer via `ghk mcp install`.

### 2.3 Context Engineering & Guardrails Engine (`src/core/context-builder.ts` & `src/core/guardrails.ts`)
Packages repository context into `.ghe/` and enforces path protection limits (`infrastructure/**`, `migrations/**`).

---

## 3. Quality Score Index Engine (`src/core/quality-score.ts`)

Calculates 6-axis feature compliance before PR merge:
- Specification AST Completeness (95%)
- Unit Test Coverage (92%)
- Integration Test Coverage (90%)
- E2E Playwright Score (88%)
- Type Safety Strictness (100%)
- Security Policy Compliance (94%)
