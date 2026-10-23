# Contributing to Gherkin AI

First off, thank you for considering contributing to Gherkin AI! It's people like you that make Gherkin AI such a great tool for Specification-Driven Development.

## Code of Conduct
By participating in this project, you are expected to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development Setup

1. Fork and clone the repository.
2. Install dependencies: `npm install`
3. Build: `npm run build` (the tests and `scripts/golden-stacks.js` use `dist/`); `npm run dev` rebuilds on change.
4. Run tests: `npm test`

## Architecture & Code Structure
Gherkin AI follows a strict architecture for generation and agent interaction:
- **Core (`src/core/`)**: Parsers, Adapters, Stack Detectors, and Constitution handling.
- **Commands (`src/commands/`)**: Commander CLI interfaces.
- **Generators (`src/generators/`)**: AST to code compilers (Contracts, Prisma, OpenAPI).
- **MCP (`src/mcp/`)**: Native Model Context Protocol Server implementations.

> **Note:** We strongly prefer deterministic generators where possible. Only use LLMs (via AgentAdapter) when dealing with ambiguity or semantic gaps.

## Pull Request Process
1. Ensure your code passes the type check (`npx tsc --noEmit`) and the tests (`npm test`, after `npm run build`).
2. Add E2E test cases in `tests/integration/` for any new CLI commands.
3. Keep PRs focused on a single responsibility.
4. If you're introducing breaking changes, describe them clearly in the description.

## Releasing

npm releases are published only by `.github/workflows/release.yml`, when a `v<version>` tag is pushed. It builds, tests, audits, publishes with provenance and creates the GitHub release with a CycloneDX SBOM. Nothing is published from a developer machine. `main` only receives commits that CI has already verified:

1. **Prepare the candidate.** Set `version` in `package.json`, date the `CHANGELOG.md` section (`## [X.Y.Z] - YYYY-MM-DD`; it becomes the release notes), commit, and create the annotated tag locally: `git tag -a vX.Y.Z -m "gherkin-ai X.Y.Z"`.
2. **Preflight.** `npm run release:preflight -- vX.Y.Z --tag vX.Y.Z` checks the tagged commit in a clean worktree, as a fresh CI runner sees it: `npm ci`, build, the golden-builds matrix, the committed JSON Schemas, the type check, `npm audit --audit-level=high`, the tag against `package.json`, actionlint, and the quick goldens (CI pipelines and Helm). Run it on Linux (WSL on Windows): Docker Desktop on Windows and macOS hides file-permission differences that the CI runners enforce.
3. **Verify the candidate in CI.** Push it to a release branch, `git push origin vX.Y.Z^{commit}:refs/heads/release/X.Y.Z`. CI runs every job on it, including all golden builds, before `main` moves. Wait until the run is green.
4. **Publish.** Fast-forward `main` to the candidate and push it, then push the tag: `git push origin main` and `git push origin vX.Y.Z`.

If CI fails on the release branch, fix it on top of the candidate, move the local tag (`git tag -fa vX.Y.Z`, allowed only while the tag is not pushed), and repeat from step 2. A pushed tag is never moved: publish a new patch version instead.

Thank you!
