# Gherkin AI CLI - Commands Reference

This document provides a comprehensive list of all commands available in the `gherkin-ai` CLI, along with their usage and flags.

---

## 🤖 Agent Orchestration & Implementation

### `ghk implement` (alias: `impl`)
Generate the **AI Agent Master Implementation Prompt & Context Package** for a feature. This command compiles `.ghkgovernance.yaml`, domain contracts (`*.contract.php`, `.ts`, `.py`, `.java`), ADRs, OpenAPI specs, and docker-compose configurations into an executable AI agent package saved at `generated-specs/prompts/implement-master-prompt.md`.

- `-f, --feature <file>`: Path to Gherkin `.feature` file (auto-selects first feature if omitted).
- `--docker`: Include Docker container sandbox execution instructions in the master prompt.
- `-C, --compact`: Generate ultra-compact prompt with minimal token footprint (~90 tokens) for low-cost LLMs.
- `--no-audit`: Disable feature execution audit trail tracking for this run.
- `--inventory` / `--history`: Display feature implementation & prompt execution audit trail history.

Example:
```bash
ghk implement --feature ./features/01-customer-management.feature
ghk impl -f ./features/01-customer-management.feature -C
```

### `ghk audit` (alias: `inventory`, `inv`, `history`)
View or export the **Feature Implementation & Prompt Execution Audit Trail Inventory**. This tracks developer identity (`git config user.name`/`email`), SHA-256 spec & prompt version hashes, timestamps, and execution status.

- `-f, --feature <file>`: Filter audit records by feature file path or feature name.
- `--json`: Output audit records as a raw JSON array for CI/CD pipelines and compliance systems.
- `--clear`: Clear/purge audit trail history.

Example:
```bash
ghk audit
ghk audit --json
ghk audit -f customer
ghk audit --clear
```

---

## 🌐 Multilingual CLI & AI Prompt Language Rationale

### `ghk lang` (alias: `l`, `language`)
Configure preferred interaction language for the CLI interface (`en` for English, `es` for Spanish).

- `-s, --set <locale>`: Set language directly (`en` or `es`).

Example:
```bash
ghk lang --set es
```

> **ℹ Token Efficiency & Reasoning Rationale**:
> While the CLI communicates with developers in Spanish or English based on their preference, the generated **Master AI Prompts (`implement-master-prompt.md`) are intentionally kept in English**.
> - **Token Savings**: LLM BPE tokenizers encode English text with ~30% higher token density than Spanish (fewer tokens per sentence).
> - **LLM Accuracy**: LLM reasoning, code generation, and type precision are highest when instructions are provided in English.

---

## 🐳 Docker Container Sandbox Host Isolation

`gherkin-ai` provisions stack-specific development containers in `docker-compose.yml` so AI agents can execute builds, migrations, and test suites inside isolated Docker containers without installing heavy runtime SDKs on the host OS:

| Language Stack | Container Runtime Image | Container Test Command |
| :--- | :--- | :--- |
| **C# / .NET** | `mcr.microsoft.com/dotnet/sdk:8.0` | `docker compose run --rm app dotnet test` |
| **Java / Spring Boot** | `eclipse-temurin:21-jdk-alpine` | `docker compose run --rm app ./gradlew test` |
| **PHP** | `php:8.3-cli-alpine` | `docker compose run --rm app vendor/bin/phpunit` |
| **Python** | `python:3.11-slim` | `docker compose run --rm app pytest` |
| **Node / TypeScript** | `node:20-alpine` | `docker compose run --rm app npm test` |
| **Go** | `golang:1.22-alpine` | `docker compose run --rm app go test ./...` |
| **Ruby** | `ruby:3.3-alpine` | `docker compose run --rm app bundle exec rspec` |

---

## 🎨 Web Studio

### `ghk web` (alias: `ui`)
Launch the local Web UI Server to visually manage your project, generate specifications, and run commands from a browser interface.
- `-p, --port <number>`: Port to run the web server on (default: `3000`).

---

## 🏗️ Architecture & Context

### `ghk detect` (alias: `d`)
Auto-detect the tech stack & architecture of the current project (Brownfield mode). This identifies the framework (React, Spring Boot, PHP, etc.) and injects standard design patterns into the agent's context.

### `ghk context [subcommand]`
Build and package project context and conventions into the `.ghe/` engine folder. This acts as a Context Engineering layer to apply guardrails for AI agents.

### `ghk quality` (alias: `q`)
Calculate the feature quality score index and enterprise gate compliance. It measures spec coverage, type safety, and potential architectural drift.

### `ghk diff`
Run Drift Detection to ensure code DTOs and contracts match the Gherkin specs.
- `-f, --feature <file>`: Gherkin feature file source of truth
- `-t, --target <file>`: Target source code file (e.g., DTO or Contract)

### `ghk evaluate <files...>` (alias: `eval`)
Evaluate one or more files for code quality and architectural pattern compliance.
- `--max-file-lines <number>`: Maximum lines allowed per file (default: 300)
- `--max-class-lines <number>`: Maximum lines allowed per class (default: 200)

---

## 📜 Specifications & Generation

### `ghk create` (alias: `c`, `new`)
Create a Gherkin feature specification interactively step-by-step from the terminal.
- `-o, --output <file>`: Output destination for `.feature` file
- `-t, --target <directory>`: Target directory to inject contracts
- `-l, --lang <locale>`: Override CLI interaction language (en or es)
- `-C, --caveman`: Enable simple prompt creation mode (skip step-by-step wizard)
- `--headless`: Run in headless non-interactive mode for CI/CD
- `--config <file>`: Path to JSON configuration file for headless mode

### `ghk generate` (alias: `g`)
Generate TypeScript contracts, DTO schemas, test fixtures, and agent prompts from a Gherkin feature spec.
- `-f, --feature <file>`: Path to Gherkin `.feature` file
- `-c, --config <file>`: Path to custom `gherkin-ai.config.json` file

### `ghk add` (alias: `a`)
Inject contracts & AI agent prompts into an existing project module.
- `-f, --feature <file>`: Path to Gherkin `.feature` file
- `-t, --target <directory>`: Target directory inside existing project
- `-c, --config <file>`: Path to custom config file

---

## 🤖 Verification & Agents

### `ghk verify` (alias: `v-loop`)
Run the closed-loop verification test harness.
- `--auto-fix`: Invoke agent self-healing loop on test failure
- `--docker`: Run test suite inside isolated Docker container
- `--max-retries <number>`: Maximum auto-fix retries (default: 3)
- `-c, --command <cmd>`: Custom test execution command

### `ghk autopilot` (alias: `auto`)
Run autonomous multi-agent delivery workflow from product requirement to PR.
- `-r, --requirement <file>`: Path to feature requirement file

### `ghk skill` (alias: `s`)
Configure Gherkin AI as a native tool/skill for AI IDEs like Cursor and Windsurf by generating `.cursorrules`.

### `ghk mcp [subcommand]`
Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server or auto-install config.
- `--install`: Auto-install MCP config into Cursor and Claude Desktop
