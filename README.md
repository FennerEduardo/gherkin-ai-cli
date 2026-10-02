# 🥒 `gherkin-ai` CLI & Agentic Verification Engine

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Spec-driven verification, governance and prompt generation for AI coding agents.**
> Turn product requirements into verifiable Gherkin specifications, generate contracts and agent prompts for many stacks, and gate pull requests on specification quality and drift.
>
> [![CI](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml)

**Using it in a company?** Read [docs/ENTERPRISE.md](docs/ENTERPRISE.md) (org-wide config and policy locks, Azure OpenAI / Bedrock / Vertex / gateways, proxy and custom CA, keychain credentials, exit codes and `--json`, least-privilege MCP, audit export). Upgrading from 2.x: [docs/MIGRATION-3.0.md](docs/MIGRATION-3.0.md).

### Supported stacks

All of these are **stable**: CI generates a sample project for each one and builds it and runs its generated tests in the stack's official Docker image.

| Kind | Stacks |
|---|---|
| Backends | TypeScript (NestJS, Express), C# (ASP.NET Core 8), Java and Kotlin (Spring Boot 3), Python (FastAPI, Django), Go (chi), PHP (Laravel 13), Ruby (Rails 8), Elixir (Phoenix), Rust (Axum), Dart (Flutter) |
| Frontends | React 19, Vue 3, Angular 22, Next.js 16, React Native (Expo 57), Flutter, Phoenix LiveView |
| Contracts | gRPC (Protobuf, buf-linted), GraphQL SDL |

Other combinations are experimental. See [docs/ENTERPRISE.md#11-stack-support-tiers](docs/ENTERPRISE.md#11-stack-support-tiers). Run `ghk stacks` for the current list.

---

## 🌟 Strategic Capabilities

While basic AI spec tools only generate text prompts, `gherkin-ai` acts as an **executable contract and verification harness** between Product Intent, AI Agents (Cursor, Antigravity, Claude Code, Windsurf, Copilot), Code Implementation, and CI/CD Quality Gates:

- 🤖 **AI Agent Implementation Orchestration (`ghk implement`)** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): Compiles `.ghkgovernance.yaml`, domain contracts (`*.contract.php`, `.ts`, `.py`, `.java`, `.go`, `.ex`, `.kt`, `.proto`, `.graphql`), ADRs, and Gherkin features into a copy-pasteable Master Agent Implementation Prompt.
- 🌳 **Official Cucumber AST Parser** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): 100% compliant with the Gherkin standard using the official `@cucumber/gherkin` package.
- 📋 **Feature Inventory & Developer Audit Trail (`ghk audit`)** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): Auto-detects developer identity (`git config user.name`/`email`), SHA-256 spec & prompt hashes, timestamps, and execution records stored in `.ghe/inventory.json` with LRU retention limit (`maxEntries: 50`) and `--json` export for CI/CD audit pipelines.
- 🐳 **Docker Container Sandbox & Host Protection (`--docker`)** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): Generates stack-specific dev container environments (`mcr.microsoft.com/dotnet/sdk`, `eclipse-temurin:21`, `elixir:1.16`, `golang:1.22`, `php:8.3`, `python:3.12`, `ruby:3.3`, `node:20`) so AI agents run tests inside isolated Docker containers without polluting host OS.
- ⚡ **Token Efficiency & Ultra-Compact Mode (`-C, --compact`)** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): Uses direct `@` context pointers (`@.ghkgovernance.yaml`, `@features/*.feature`) for on-demand resolution to radically reduce token footprint vs. code dumping, providing an ultra-compact prompt mode for cost-sensitive LLMs.
- 🌐 **Multilingual CLI & English Prompt Rationale (`ghk lang`)** ![STABLE](https://img.shields.io/badge/status-STABLE-brightgreen): Full interactive CLI support in Spanish (`es`) and English (`en`). Master AI Prompts are intentionally generated in **English** for maximum BPE token density (~30% cheaper) and LLM reasoning accuracy.
- 🌐 **Web Studio UI (`ghk web`)** ![BETA](https://img.shields.io/badge/status-BETA-yellow): Launch a premium local graphical interface to interactively generate your Gherkin specifications, detect your stack, and orchestrate agent prompts visually.
- 🤖 **Agentic repair loop (`ghk verify --auto-fix` & `ghk autopilot`)** ![EXPERIMENTAL](https://img.shields.io/badge/status-EXPERIMENTAL-orange): Calls an LLM (OpenAI, Azure OpenAI, Anthropic, Bedrock, Gemini/Vertex, OpenAI-compatible gateways, Ollama) to propose fixes when tests fail. Changes are written as `.patch` files unless you pass `--apply`, and `--apply` is refused in CI and on protected branches unless explicitly allowed. Run it with human review.

---

## 📥 Installation & Execution

```bash
# Global Installation
npm install -g gherkin-ai

# Or Zero-Install On-Demand
npx -y gherkin-ai implement --feature ./features/01-customer-management.feature
```

---

## 🚀 Quick Start Commands

```bash
# 1. Initialize Stack Architecture (Supports 14+ Stacks)
ghk init --yes -l java -f spring-boot --frontendFramework vue

# 2. Generate Master Agent Implementation Prompt (Docker Sandbox & Compact Mode)
ghk implement --docker -C --feature ./features/01-customer-management.feature

# 3. View Feature Inventory & Developer Audit Trail History
ghk audit

# 4. Export Audit History as JSON for CI/CD Compliance Pipelines
ghk audit --json

# 5. Configure CLI Language (English or Spanish)
ghk lang --set en

# 6. Run Closed-Loop Test Verification with Auto-Fix Loop
ghk verify --isolated --auto-fix --apply
```

---

## ⚠️ Known Limitations

In the interest of transparency, please note the following current limitations:
- **Experimental Agent Loops:** The `ghk verify --auto-fix` and `ghk autopilot` commands utilize autonomous LLM loops that are strictly experimental. While circuit breakers and Testcontainers are used, they can still exhibit unpredictable behavior or loops if the LLM cannot resolve the compiler error.
- **Semantic IR Regex Extraction:** The internal IR builder still relies heavily on RegEx pattern matching rather than deep AST interpretation for some advanced semantic features.

---

## 📖 Comprehensive Documentation

- [Multi-Stack Evaluation Report (15 Projects)](docs/EVALUATION_REPORT.md)
- [CLI Commands Reference Guide](docs/COMMANDS.md)
- [Model Context Protocol (MCP) Integration Guide](docs/MCP_GUIDE.md)
- [Closed-Loop Verification & Auto-Repair Guide](docs/USAGE_GUIDE.md)
- [Architecture & Agent Pipeline Design](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/gherkin-ai-agent-architect)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
