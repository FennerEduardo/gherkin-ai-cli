# 🏗️ `gherkin-ai` CLI Architecture & Agent Pipeline Design

This document details the internal design, Abstract Syntax Tree (AST) parsing pipeline, multi-stack detection, and contract generation mechanisms of `gherkin-ai` CLI.

---

## 1. System Architecture Diagram

```text
 ┌──────────────────────┐
 │ Gherkin (.feature)   │
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐      ┌───────────────────────┐
 │ gherkin-parser.ts    ├─────►│ ParsedFeature (AST)   │ (Bilingual EN / ES)
 └──────────────────────┘      └──────────┬────────────┘
                                          │
                                          ▼
 ┌──────────────────────┐      ┌───────────────────────┐
 │ stack-detector.ts   ├─────►│ Detected Stack        │ (Laravel, Rails, .NET, Angular, Nest, etc.)
 └──────────────────────┘      └──────────┬────────────┘
                                          │
                                          ▼
 ┌──────────────────────┐      ┌───────────────────────┐
 │ i18n-cli.ts          ├─────►│ User Locale Context   │ (English / Spanish)
 └──────────────────────┘      └──────────┬────────────┘
                                          │
               ┌──────────────────────────┼──────────────────────────┐
               ▼                          ▼                          ▼
 ┌──────────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
 │ contracts.ts Generator   │ │ fixtures.ts Generator │ │ prompts.ts Generator  │
 └─────────────┬────────────┘ └───────────┬───────────┘ └───────────┬───────────┘
               │                          │                         │
               ▼                          ▼                         ▼
      contracts.ts / ADRs            seed.sql / TS             Agent Prompts
```

---

## 2. Core Components

### 2.1 AST Parser (`src/core/gherkin-parser.ts`)
Parses `.feature` text into structured models with native bilingual support:
- **Feature Title & Business Goal** (supports `Feature:` / `Característica:`)
- **Scenarios & Given/When/Then Steps** (supports `Scenario:` / `Escenario:`, `Given` / `Dado`, `When` / `Cuando`, `Then` / `Entonces`, `And` / `Y`, `But` / `Pero`).
- **Domain Analysis**: Automatically classifies step phrases into Actors, Commands, Queries, Events, and Fixtures.

### 2.2 Stack Auto-Detector (`src/core/stack-detector.ts`)
Inspects root workspace files to identify the tech stack of existing projects:
- **PHP / Laravel**: Inspects `artisan` and `composer.json`.
- **Ruby on Rails**: Inspects `Gemfile` and `Rakefile`.
- **C# / .NET**: Inspects `Program.cs` and `appsettings.json`.
- **Java / Spring Boot**: Inspects `pom.xml` and `build.gradle`.
- **Python (Django / FastAPI)**: Inspects `manage.py`, `pyproject.toml`, `requirements.txt`.
- **Go**: Inspects `go.mod`.
- **Frontend & Mobile**: Inspects `angular.json` (Angular / Ionic), `react-native`, `pubspec.yaml` (Flutter/Dart).

### 2.3 Interactive CLI i18n Engine (`src/utils/i18n-cli.ts`)
Manages CLI locale preferences (`en` / `es`):
- Defaults to **English** (`en`).
- Persists user preferences globally in `~/.gherkin-ai/config.json`.
- Allows switching preferred CLI language anytime using `ghk lang`.

### 2.4 Interactive Spec Wizard (`src/commands/create.ts`)
Guides users step-by-step through terminal prompts to build Gherkin `.feature` specifications in English or Spanish, saving the resulting file and offering direct contract injection.

### 2.5 Contract & DTO Generator (`src/generators/contracts.ts`)
Transforms parsed AST commands into valid Zod validation schemas, OpenAPI 3.0 JSON specifications, and TypeScript interfaces:
- `IDomainEvent` & explicit event schemas.
- Command DTO schemas for input validation.
- Outbound repository ports (`IRepository`).
- CQRS Event Store ports (`IEventStore`, `IAggregateRoot<T>`, `ISnapshotStore<T>`).

---

## 3. Agent Execution Strategy

To prevent AI coding agents from diverging or producing uncompilable code:
1. **Domain Architect Agent** reads `contracts.ts` and implements pure business logic without external dependencies.
2. **Backend Developer Agent** uses `contracts.ts` and `fixtures.ts` to implement Use Cases, Controllers, and ORM Repositories (NestJS, Laravel, Rails, .NET, Spring Boot).
3. **QA Automation Agent** uses `fixtures.ts` and `.feature` files to write deterministic unit and integration tests (Jest, PHPUnit, RSpec, xUnit, Pytest).
