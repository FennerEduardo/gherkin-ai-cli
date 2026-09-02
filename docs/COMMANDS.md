# Gherkin AI CLI - Commands Reference

This document provides a comprehensive list of all commands available in the `gherkin-ai` CLI, along with their usage and flags.

## Web Studio
### `ghk web` (alias: `ui`)
Launch the local Web UI Server to visually manage your project, generate specifications, and run commands from a browser interface.
- `-p, --port <number>`: Port to run the web server on (default: `3000`).

## Architecture & Context
### `ghk detect` (alias: `d`)
Auto-detect the tech stack & architecture of the current project (Brownfield mode). This identifies the framework (React, Spring Boot, etc.) and injects standard design patterns into the agent's context.

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

## Specifications & Generation
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

## Verification & Agents
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

## Settings
### `ghk lang` (alias: `l`, `language`)
Configure CLI preferred interaction language.
- `-s, --set <locale>`: Set language directly (`en` or `es`)
