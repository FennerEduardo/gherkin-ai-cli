# 🥒 `gherkin-ai` CLI

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Bridge the gap between business specifications and AI Coding Agents.**
> Convert Gherkin `.feature` files into production-ready TypeScript contracts, Zod schemas, deterministic test seeds, and role-specialized executable prompt packages for AI Agents (**Claude Code, Cursor, Antigravity, Windsurf, GitHub Copilot Workspace**).

---

## 🌟 Why `gherkin-ai`?

While simple AI prompt generators produce generic text instructions, AI agents often invent conflicting package versions, violate domain boundaries, or fail to write working tests due to missing setup state.

`gherkin-ai` CLI solves this by generating **deterministic technical rails**:
- **`contracts.ts`**: Strict domain interfaces, event schemas, Zod DTOs, and Architecture Decision Records (ADRs).
- **`fixtures.ts` & `seed.sql`**: Concrete database seeds (hashed passwords, bcrypt cost factor 12, pre-conditions) to make `Given` steps executable.
- **Strict Stack Versions**: Enforces explicit package versions (e.g., NestJS v10 + Prisma + Zod + Redis) so agents never diverge.
- **Runnable Infrastructure**: Includes pre-configured `docker-compose.yml` and `.env.example`.

---

## 🚀 Quick Start

Run instantly with `npx`:

```bash
# 1. Initialize project configuration interactively
npx gherkin-ai init

# 2. Generate contracts, fixtures, and AI agent prompts from your feature file
npx gherkin-ai generate --feature ./specs/auth.feature

# 3. Validate architecture rules and Gherkin compliance
npx gherkin-ai validate --feature ./specs/auth.feature
```

Or install globally:

```bash
npm install -g gherkin-ai
gherkin-ai --help
```

---

## 🏗️ Supported Architecture Styles

- **Hexagonal Architecture (Ports & Adapters)**
- **Domain-Driven Design (DDD)**
- **Clean Architecture**
- **CQRS + Event Sourcing**
- **Microservices Architecture**

---

## 📦 Generated Artifacts Structure

Running `gherkin-ai generate` produces the following folder structure:

```text
generated-specs/
├── contracts.ts                      # Interfaces, Zod schemas & repository ports
├── fixtures.ts                       # Test seed functions (bcrypt, Given setup)
├── seed.sql                          # Raw SQL initialization script
├── docker-compose.yml                # Pre-configured PostgreSQL, Redis, RabbitMQ
├── .env.example                      # Environment variables template
├── ADR-001-architecture-decisions.md # Architecture Decision Record
└── prompts/
    ├── domain-agent.md               # Instructions for Domain Architect Agent
    ├── backend-agent.md              # Instructions for Backend Developer Agent
    └── qa-agent.md                   # Instructions for QA Automation Agent
```

---

## 📖 Complete Documentation

- [Comprehensive Usage Guide](docs/USAGE_GUIDE.md)
- [CLI Architecture & Agent Pipeline](docs/ARCHITECTURE.md)
- [Live Web SPA Playground](https://fennereduardo.com/pages/GherkinIATool/)

---

## 📄 License

Distributed under the [MIT License](LICENSE). Created by [Fenner Eduardo](https://fennereduardo.com).
