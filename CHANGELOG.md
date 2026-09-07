# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.1] - 2026-09-07

### Fixed
- Added `@vitest/coverage-v8` to devDependencies.
- Migrated Vitest configuration to `vitest.config.mts` for native ESM compatibility.
- Updated local `publish:prod` script to remove `--provenance` flag for CLI terminal execution.

## [2.6.0] - 2026-09-07 - Official Enterprise Release

### Added
- **Semantic Intermediate Representation (IR Engine):** Rich 37KB AST & NLP extractor (`src/core/ir-builder.ts`) for state machines, domain events, invariants, and traceability.
- **Enterprise Constitution & Guardrails (`.gherkin-ai/`):** Full YAML governance schema (`src/core/constitution.ts`), agent role permissions, LLM policies, and compliance framework schemas.
- **Specification Linter (`ghk lint`):** 14 linting rules for Gherkin specifications with quality scoring and CLI diagnostic outputs.
- **Specification Convergence Engine (`ghk converge`):** 6-dimensional spec-to-code alignment verification system with CONVERGED / DIVERGED status badges.
- **OpenAPI Schema Validator (`src/core/openapi-validator.ts`):** Validates generated OpenAPI 3.0 specs against Gherkin endpoints.
- **Plugin Architecture (`src/core/plugin-system.ts`):** Extensible plugin interface for third-party generators and presets.
- **Impact Analysis (`ghk impact`) & PR Reviewer (`ghk pr-review`):** Blast radius analyzer and automated PR review bot.
- **Prisma Schema & Zod Generator (`src/generators/prisma-generator.ts`):** Auto-generates `schema.prisma` from IR entities and state machines, with conditional `npx prisma format` execution.
- **Failed Attempt Diagnostics Logging:** Automatically logs raw prompts, responses, and diffs to `.gherkin-ai/logs/autopilot/` pre-rollback on agent failures.
- **Supply Chain Security & Provenance:** Published with npm `--provenance` and included GitHub Actions CI workflow generator.

### Fixed
- **Dynamic Spec Directory Resolver (`src/utils/spec-dir-resolver.ts`):** Fixed critical `ENOENT: specs/` bug by auto-resolving `features/`, `specs/`, or `specDir` in configuration.
- **Non-Interactive CI Mode:** Automatic directory suggestion/selection in headless mode without prompt locks.
- **Clean Architecture Import Compliance:** Removed `@nestjs/common` imports from step definition presets to guarantee 0 layer violations in `ghk validate`.

## [2.3.1] - 2026-09-02
### Changed
- Promoted self-healing engine from beta to stable.
- Minor performance patches.

## [2.2.0] - 2026-08-15
### Added
- Web Studio UI (`ghk web`) for visual orchestrating.
- AST Step Definitions Indexer for hallucination prevention via `ts-morph`.
- DOM & Data Model Anchor for precise test generation.
- `ghk skill` command for IDE (.cursorrules) integration.
- Headless CI/CD Mode.
- Official `@cucumber/gherkin` parser support.
- Initial multi-stack templates (Rust, Go, Mobile, React, Java).
