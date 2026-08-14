# 🥒 `gherkin-ai` CLI

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Bridge the gap between business specifications and AI Coding Agents.**
> Convert Gherkin `.feature` files into production-ready TypeScript contracts, Zod schemas, OpenAPI specs, deterministic test seeds, and role-specialized executable prompt packages for AI Agents (**Claude Code, Cursor, Antigravity, Windsurf, GitHub Copilot Workspace**).

---

## 🌟 Why `gherkin-ai`?

While simple AI prompt generators produce generic text instructions, AI agents often invent conflicting package versions, violate domain boundaries, or fail to write working tests due to missing setup state.

`gherkin-ai` CLI solves this by generating **deterministic technical rails**:
- **`contracts.ts`**: Strict domain interfaces, event schemas, Zod DTOs, CQRS Event Store ports, and Architecture Decision Records (ADRs).
- **`openapi.json`**: Auto-generated OpenAPI 3.0 specification derived directly from Gherkin AST schemas.
- **`fixtures.ts` & `seed.sql`**: Concrete database seeds (hashed passwords, bcrypt cost factor 12, pre-conditions) raising AI acceptance test success rates from ~30% to ~85%.
- **Strict Stack Versions**: Enforces explicit package versions (e.g., NestJS v10 + Prisma + Zod + Redis) so agents never diverge.
- **Runnable Infrastructure**: Includes pre-configured `docker-compose.yml` (PostgreSQL, Redis, RabbitMQ) and native AWS Lambda `serverless.yml` for FaaS architectures.
- **`gherkin-ai validate`**: Deep Architectural Linter checking layer boundary import isolation, step coverage, and circular dependency rules.

---

## 🚀 Quick Start & Short Aliases

You can use the short command alias **`ghk`** (or `gherkin-cli` / `gherkin-ia`) for fast typing:

```bash
# 1. Initialize project configuration interactively
ghk init     # (or: npx ghk init)

# 2. Generate contracts, OpenAPI, fixtures, and AI agent prompts from your feature file
ghk generate --feature ./specs/auth.feature   # (or short alias: ghk g)

# 3. Perform deep architectural linting and layer boundary checks
ghk validate --feature ./specs/auth.feature   # (or short alias: ghk v)
```

Or install globally:

```bash
npm install -g gherkin-ai
ghk --help
```

---

## 🏗️ Supported Architecture Styles

- **Hexagonal Architecture (Ports & Adapters)**
- **Domain-Driven Design (DDD)**
- **Clean Architecture**
- **CQRS + Event Sourcing (Real Event Store & Aggregate Versions)**
- **Serverless / FaaS (Native AWS Lambda & `serverless.yml`)**
- **Microservices Architecture**

---

## 📦 Generated Artifacts Structure

Running `gherkin-ai generate` (or `ghk g`) produces the following folder structure:

```text
generated-specs/
├── contracts.ts                      # Interfaces, Zod schemas, Repository & Event Store ports
├── openapi.json                      # Auto-generated OpenAPI 3.0 specification
├── fixtures.ts                       # Test seed functions (bcrypt, Given setup)
├── seed.sql                          # Raw SQL initialization script
├── docker-compose.yml / serverless.yml # Pre-configured infrastructure
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
