# 📘 `gherkin-ai` CLI Usage Guide & Tutorial

This guide provides step-by-step instructions for installing, configuring, and executing `gherkin-ai` CLI in your development workflow.

---

## Table of Contents

1. [Installation & Short Alias (`ghk`)](#1-installation--short-alias-ghk)
2. [Language Configuration (`ghk lang`)](#2-language-configuration-ghk-lang)
3. [Interactive Gherkin Spec Wizard (`ghk create`)](#3-interactive-gherkin-spec-wizard-ghk-create)
4. [Existing Projects / Brownfield Mode (`ghk detect` & `ghk add`)](#4-existing-projects--brownfield-mode-ghk-detect--ghk-add)
5. [New Projects / Greenfield Mode (`ghk init` & `ghk generate`)](#5-new-projects--greenfield-mode-ghk-init--ghk-generate)
6. [Command Reference](#6-command-reference)
7. [Feeding Generated Prompts into AI Agents](#7-feeding-generated-prompts-into-ai-agents)

---

## 1. Installation & Short Alias (`ghk`)

Run `gherkin-ai` instantly without installation using `npx` and the short alias **`ghk`**:

```bash
npx ghk --version
```

Or install it globally:

```bash
npm install -g gherkin-ai
ghk --help
```

---

## 2. Language Configuration (`ghk lang`)

By default, CLI interactions run in **English**. You can switch CLI interaction language to **Spanish** or **English** at any time.

```bash
# Interactive language selector
ghk lang

# Or set directly
ghk lang --set es   # Switch to Spanish
ghk lang --set en   # Switch to English
```

The language preference is saved globally under `~/.gherkin-ai/config.json` and automatically applies to all future terminal sessions.

---

## 3. Interactive Gherkin Spec Wizard (`ghk create`)

Build a Gherkin specification step-by-step interactively directly in your terminal without typing raw `.feature` syntax:

```bash
ghk create    # (or alias: ghk new)
```

The wizard prompts you for:
1. Feature Name (e.g. *Two Factor Authentication 2FA* / *Autenticación de Doble Factor*)
2. Actor (*As a...* / *Como...*)
3. Action (*I want to...* / *Quiero...*)
4. Benefit (*So that...* / *Para...*)
5. Scenario Name & Step Loop (`Given`/`Dado`, `When`/`Cuando`, `Then`/`Entonces`, `And`/`Y`).

After creation, it saves the file to `./specs/` and offers to immediately inject contracts into your project.

---

## 4. Existing Projects / Brownfield Mode (`ghk detect` & `ghk add`)

If you have an existing codebase (**Laravel, Rails, ASP.NET Core, Angular, Ionic, Spring Boot, NestJS, FastAPI, Django, Flutter**):

### Step 1: Auto-Detect Tech Stack

```bash
ghk detect
```

Scans your root directory for manifests (`package.json`, `artisan`, `composer.json`, `pom.xml`, `go.mod`, `requirements.txt`, `Gemfile`, `angular.json`, `pubspec.yaml`) and saves `gherkin-ai.config.json` with `projectMode: "brownfield"`.

### Step 2: Inject Feature Contracts into Existing Modules

```bash
ghk add --feature ./specs/payments.feature --target ./src/modules/payments
```

Injects `<feature>.contract.ts`, `<feature>.openapi.json`, `ADR-<feature>.md`, and specialized AI prompts directly inside `./src/modules/payments/` without modifying the rest of your application.

---

## 5. New Projects / Greenfield Mode (`ghk init` & `ghk generate`)

For starting a brand-new service from scratch:

```bash
# 1. Initialize configuration
ghk init

# 2. Generate complete specification artifacts
ghk generate --feature ./specs/auth.feature

# 3. Perform architectural linting
ghk validate --feature ./specs/auth.feature
```

Generates:
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

## 6. Command Reference

| Command | Alias | Description |
|---|---|---|
| `ghk init` | `i` | Initialize interactive project configuration (`gherkin-ai.config.json`). |
| `ghk lang` | `l`, `language` | Configure preferred CLI interaction language (English or Spanish). |
| `ghk create` | `c`, `new` | Interactive terminal wizard to build Gherkin `.feature` specs step-by-step. |
| `ghk detect` | `d` | Auto-detect stack & architecture of an existing codebase (Brownfield mode). |
| `ghk add` | `a` | Inject contracts and AI prompts into a specific module in an existing project. |
| `ghk generate` | `g` | Generate complete contracts, OpenAPI, seeds, docker-compose, and prompts. |
| `ghk validate` | `v` | Perform deep architectural linting and layer boundary checks. |
| `ghk export` | `e` | Export a single Markdown or JSON context bundle for AI agents. |

---

## 7. Feeding Generated Prompts into AI Agents

### For Claude Code / Terminal Agents:
```bash
claude "Read generated-specs/prompts/backend-agent.md and contracts.ts. Implement the controllers and services in src/."
```

### For Cursor / Windsurf / Antigravity / IDE Agents:
1. Open `@contracts.ts` (or `@<module>.contract.ts`) in your workspace.
2. Load `@prompts/backend-agent.md` as context.
3. Instruct the AI agent: *"Implement the application use cases and controllers following the contract interfaces."*
