# 🥒 `gherkin-ai` CLI & Agentic Verification Engine

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The Closed-Loop Agentic Testing & Orchestration Engine for Full-Stack Applications.**
> Turn product requirements into verifiable Gherkin specifications, execute 15+ multi-stack implementations (React/Vue/Angular + Java / Kotlin / Go / Elixir / PHP / Ruby / Python / .NET / Flutter / React Native, plus gRPC & GraphQL contracts), and experiment with self-healing agent loops.
> 
> [![CI](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml)
> [![Coverage Status](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)]()

---

## 🌟 Strategic Capabilities

While basic AI spec tools only generate text prompts, `gherkin-ai` acts as an **executable contract and verification harness** between Product Intent, AI Agents (Cursor, Antigravity, Claude Code, Windsurf, Copilot), Code Implementation, and CI/CD Quality Gates:

- 🤖 **AI Agent Implementation Orchestration (`ghk implement`)**: Compiles `.ghkgovernance.yaml`, domain contracts (`*.contract.php`, `.ts`, `.py`, `.java`, `.go`, `.ex`, `.kt`, `.proto`, `.graphql`), ADRs, and Gherkin features into a copy-pasteable Master Agent Implementation Prompt.
- 🐳 **Docker Container Sandbox & Host Protection (`--docker`)**: Generates stack-specific dev container environments (`mcr.microsoft.com/dotnet/sdk`, `eclipse-temurin:21`, `elixir:1.16`, `golang:1.22`, `php:8.3`, `python:3.12`, `ruby:3.3`, `node:20`) so AI agents run tests inside isolated Docker containers without polluting host OS.
- 📋 **Feature Inventory & Developer Audit Trail (`ghk audit`)**: Auto-detects developer identity (`git config user.name`/`email`), SHA-256 spec & prompt hashes, timestamps, and execution records stored in `.ghe/inventory.json` with LRU retention limit (`maxEntries: 50`) and `--json` export for CI/CD audit pipelines.
- ⚡ **Token Efficiency & Ultra-Compact Mode (`-C, --compact`)**: Uses direct `@` context pointers (`@.ghkgovernance.yaml`, `@features/*.feature`) for on-demand resolution to radically reduce token footprint vs. code dumping, providing an ultra-compact prompt mode for cost-sensitive LLMs.
- 🌐 **Multilingual CLI & English Prompt Rationale (`ghk lang`)**: Full interactive CLI support in Spanish (`es`) and English (`en`). Master AI Prompts are intentionally generated in **English** for maximum BPE token density (~30% cheaper) and LLM reasoning accuracy.
- 🤖 **True Agentic Engine & Self-Healing (EXPERIMENTAL - `ghk verify --auto-fix` & `ghk autopilot`)**: Connects natively with LLMs (OpenAI, Anthropic, Ollama), modifies source code, intercepts test failures, and recursively applies repairs in a true **Closed-Loop**. *Note: Agentic execution is currently experimental and should be run with human supervision.*
- 🌐 **Web Studio UI (`ghk web`)**: Launch a premium local graphical interface to interactively generate your Gherkin specifications, detect your stack, and orchestrate agent prompts visually.
- 🌳 **Official Cucumber AST Parser**: 100% compliant with the Gherkin standard using the official `@cucumber/gherkin` package.

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
ghk init --stack=java-springboot_vue-pinia

# 2. Generate Master Agent Implementation Prompt (Docker Sandbox & Compact Mode)
ghk implement --docker -C --feature ./features/01-customer-management.feature --contract ./contracts/customer.contract.java

# 3. View Feature Inventory & Developer Audit Trail History
ghk audit

# 4. Export Audit History as JSON for CI/CD Compliance Pipelines
ghk audit --json

# 5. Configure CLI Language (English or Spanish)
ghk lang --set en

# 6. Run Closed-Loop Test Verification with Auto-Fix Loop
ghk verify --docker --auto-fix
```

---

## 📖 Comprehensive Documentation

- [CLI Commands Reference Guide](docs/COMMANDS.md)
- [Model Context Protocol (MCP) Integration Guide](docs/MCP_GUIDE.md)
- [Closed-Loop Verification & Auto-Repair Guide](docs/USAGE_GUIDE.md)
- [Architecture & Agent Pipeline Design](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/gherkin-ai-agent-architect)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
