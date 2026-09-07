# Contributing to Gherkin AI

First off, thank you for considering contributing to Gherkin AI! It's people like you that make Gherkin AI such a great tool for Specification-Driven Development.

## Code of Conduct
By participating in this project, you are expected to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development Setup

1. Fork and clone the repository.
2. Install dependencies: \`npm install\`
3. Run the build watcher: \`npm run build:watch\`
4. Run tests: \`npm run test\`

## Architecture & Code Structure
Gherkin AI follows a strict architecture for generation and agent interaction:
- **Core (`src/core/`)**: Parsers, Adapters, Stack Detectors, and Constitution handling.
- **Commands (`src/commands/`)**: Commander CLI interfaces.
- **Generators (`src/generators/`)**: AST to code compilers (Contracts, Prisma, OpenAPI).
- **MCP (`src/mcp/`)**: Native Model Context Protocol Server implementations.

> **Note:** We strongly prefer deterministic generators where possible. Only use LLMs (via AgentAdapter) when dealing with ambiguity or semantic gaps.

## Pull Request Process
1. Ensure your code passes all linting (`npm run lint`) and tests (`npm run test`).
2. Add E2E test cases in `tests/integration/` for any new CLI commands.
3. Keep PRs focused on a single responsibility.
4. If you're introducing breaking changes, describe them clearly in the description.

Thank you!
