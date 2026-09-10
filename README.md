# 🥒 `gherkin-ai` CLI & Agentic Verification Engine

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **The Closed-Loop Agentic Testing & Orchestration Engine for Enterprise Full-Stack Applications.**
> Turn product requirements into verifiable Gherkin specifications, execute dual-stack implementations (React + Java / PHP / .NET / Python), and run self-healing agent loops with zero regressions.

---

## 🌟 Strategic Capabilities (`v2.6.1` Stable Release)

While basic AI spec tools only generate text prompts, `gherkin-ai` acts as an **executable contract and verification harness** between Product Intent, AI Agents (Cursor, Antigravity, Claude Code, Windsurf, Copilot), Code Implementation, and CI/CD Quality Gates:

- 🤖 **AI Agent Implementation Orchestration (`ghk implement`)**: Compiles `.ghkgovernance.yaml`, domain contracts (`*.contract.php`, `.ts`, `.py`, `.java`), ADRs, and Gherkin features into a copy-pasteable Master Agent Implementation Prompt.
- 🐳 **Docker Container Sandbox & Host Protection (`--docker`)**: Generates stack-specific dev container environments (`mcr.microsoft.com/dotnet/sdk:8.0`, `eclipse-temurin:21-jdk-alpine`, `php:8.3-cli-alpine`, `python:3.11-slim`, `node:20-alpine`, `golang:1.22-alpine`, `ruby:3.3-alpine`) so AI agents run tests inside isolated Docker containers without polluting host OS.
- 📋 **Feature Inventory & Developer Audit Trail (`ghk audit`)**: Auto-detects developer identity (`git config user.name`/`email`), SHA-256 spec & prompt hashes, timestamps, and execution records stored in `.ghe/inventory.json` with LRU retention limit (`maxEntries: 50`) and `--json` export for CI/CD audit pipelines.
- ⚡ **Token Efficiency & Ultra-Compact Mode (`-C, --compact`)**: Uses direct `@` file pointers for on-demand context resolution (70–85% token savings vs code dumping) and provides a dense ~90-token compact prompt mode for cost-sensitive LLMs.
- 🌐 **Multilingual CLI & English Prompt Rationale (`ghk lang`)**: Full interactive CLI support in Spanish (`es`) and English (`en`). Master AI Prompts are intentionally generated in **English** for maximum BPE token density (~30% cheaper) and LLM reasoning accuracy.
- 🤖 **True Agentic Engine & Self-Healing (`ghk verify --auto-fix` & `ghk autopilot`)**: Connects natively with LLMs (OpenAI, Anthropic, Ollama), modifies source code, intercepts test failures, and recursively applies repairs in a true **Closed-Loop**.
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
# 1. Generate Master AI Agent Implementation Prompt & Context Package
ghk implement --feature ./features/01-customer-management.feature

# 2. Generate Ultra-Compact Prompt for Low-Cost LLMs (~90 tokens)
ghk implement --feature ./features/01-customer-management.feature --compact

# 3. View Feature Inventory & Developer Audit Trail History
ghk audit

# 4. Export Audit History as JSON for CI/CD Compliance Pipelines
ghk audit --json

# 5. Configure CLI Language (English or Spanish)
ghk lang --set es

# 6. Run Closed-Loop Test Verification with Auto-Fix Loop
ghk verify --auto-fix
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
