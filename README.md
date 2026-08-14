# 🥒 `gherkin-ai` CLI

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Bridge the gap between business specifications and AI Coding Agents.**
> Convert Gherkin `.feature` files into production-ready TypeScript contracts, Python Pydantic DTOs, PHP 8.2 Classes, Go Structs, C# Records, OpenAPI specs, deterministic test seeds, and role-specialized executable prompt packages for AI Agents (**Claude Code, Cursor, Antigravity, Windsurf, GitHub Copilot Workspace**).

---

## 🌟 Why `gherkin-ai`?

While simple AI prompt generators produce generic text instructions, AI agents often invent conflicting package versions, violate domain boundaries, or fail to write working tests due to missing setup state.

`gherkin-ai` CLI solves this by generating **deterministic technical rails**:
- **Native Model Context Protocol (MCP) Server (`ghk mcp`)**: Exposes stdio MCP JSON-RPC 2.0 tools so Claude Desktop, Cursor, Antigravity, and Windsurf can invoke `gherkin-ai` tools directly.
- **Native Multi-Language Contracts (`contracts.py`, `contracts.php`, `contracts.go`, `contracts.cs`, `contracts.ts`)**: Strict domain interfaces and DTOs generated natively for your target language (Pydantic v2 in Python, Readonly Classes in PHP 8.2, Structs in Go, Records in C#).
- **`openapi.json`**: Auto-generated OpenAPI 3.0 specification derived directly from Gherkin AST schemas.
- **`fixtures.ts` & `seed.sql`**: Concrete database seeds (hashed passwords, bcrypt cost factor 12, pre-conditions) raising AI acceptance test success rates from ~30% to ~85%.
- **Interactive Spec Wizard (`ghk create`)**: Create Gherkin specifications step-by-step directly from your terminal.
- **Brownfield Integration (`ghk detect` & `ghk add`)**: Inject contracts directly into existing project module folders (Laravel, Rails, .NET, Angular, NestJS, etc.).
- **Bilingual Gherkin Parsing**: Native support for English (`Given/When/Then`) and Spanish (`Dado/Cuando/Entonces`).

---

## 🚀 Quick Start Commands

### 1. Model Context Protocol (MCP) Server

Connect your AI Agent (Claude Desktop, Cursor, Antigravity) directly to `gherkin-ai`:

```bash
ghk mcp
```

*(See the complete [MCP Integration Guide](docs/MCP_GUIDE.md) for step-by-step setup).*

### 2. Create a Gherkin Spec Interactively (`ghk create`)

```bash
ghk create   # (or: ghk new)
```

### 3. Existing Projects (Brownfield Mode)

```bash
# 1. Auto-detect stack (Laravel, Rails, .NET, NestJS, Angular, Flutter, etc.)
ghk detect

# 2. Inject native language contract directly into an existing module folder
ghk add --feature ./specs/payments.feature --target ./src/modules/payments
```

---

## 📖 Complete Documentation

- [Model Context Protocol (MCP) Integration Guide](docs/MCP_GUIDE.md)
- [Comprehensive Usage Guide](docs/USAGE_GUIDE.md)
- [CLI Architecture & Agent Pipeline](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/GherkinIATool/)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
