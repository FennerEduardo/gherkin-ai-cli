# 📘 `gherkin-ai` CLI Usage Guide & Tutorial

This guide provides step-by-step instructions for installing, configuring, and executing `gherkin-ai` CLI in your development workflow.

---

## Table of Contents

1. [Installation](#installation)
2. [CLI Configuration (`gherkin-ai.config.json`)](#cli-configuration)
3. [Writing Gherkin Features](#writing-gherkin-features)
4. [Command Reference](#command-reference)
   - [`init`](#init)
   - [`generate`](#generate)
   - [`validate`](#validate)
   - [`export`](#export)
5. [Feeding Generated Prompts into AI Agents](#feeding-prompts-into-ai-agents)

---

## 1. Installation

You can run `gherkin-ai` directly without installation using `npx`:

```bash
npx gherkin-ai --version
```

Or install it globally using npm:

```bash
npm install -g gherkin-ai
```

---

## 2. CLI Configuration

Run `gherkin-ai init` to generate a `gherkin-ai.config.json` file in your root folder:

```json
{
  "projectName": "auth-service",
  "architecture": "hexagonal",
  "stack": {
    "language": "typescript",
    "framework": "nestjs",
    "orm": "prisma",
    "database": "postgresql",
    "validation": "zod",
    "auth": "jwt-bcrypt",
    "messaging": "rabbitmq",
    "testing": "jest"
  },
  "rules": {
    "bcryptCostFactor": 12,
    "jwtTtlSeconds": 3600,
    "strictLayerBoundaries": true,
    "coverageTarget": 85
  },
  "outputDir": "./generated-specs"
}
```

---

## 3. Writing Gherkin Features

Create a feature file (e.g. `./specs/auth.feature`):

```gherkin
Feature: User Authentication & Token Issuance
  As a registered system user
  I want to authenticate using valid credentials
  So that I obtain a JWT token to access protected APIs

  Scenario: Successful login with valid credentials
    Given a registered user exists with email "dev@example.com" and password "Pass123!"
    When sending an authentication request with email "dev@example.com" and password "Pass123!"
    Then the system responds with HTTP status 200 OK
    And returns a short-lived access JWT token
    And emits a "UserAuthenticated" domain event
```

---

## 4. Command Reference

### `gherkin-ai generate`

Generates TypeScript contracts, DTO schemas, test fixtures, docker-compose, and role prompts:

```bash
gherkin-ai generate --feature ./specs/auth.feature --config ./gherkin-ai.config.json
```

### `gherkin-ai validate`

Validates that your feature spec and project setup adhere to chosen architecture boundaries:

```bash
gherkin-ai validate --feature ./specs/auth.feature
```

### `gherkin-ai export`

Exports a single Markdown or JSON context bundle for AI coding agents:

```bash
gherkin-ai export --feature ./specs/auth.feature --format md --output ./agent-context.md
```

---

## 5. Feeding Generated Prompts into AI Agents

### For Claude Code / Terminal Agents:
```bash
claude "Read generated-specs/prompts/domain-agent.md and generated-specs/contracts.ts. Implement the domain entities in src/domain/."
```

### For Cursor / Windsurf / IDE Agents:
1. Open `@generated-specs/contracts.ts` in your workspace.
2. Load `@generated-specs/prompts/backend-agent.md` as context.
3. Instruct the AI agent: *"Implement the application use cases and controllers following contracts.ts."*
