# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [2.6.3](https://github.com/FennerEduardo/gherkin-ai-cli/compare/v2.6.2...v2.6.3) (2026-09-15)


### Bug Fixes

* correct package.json files array to ensure npm registry parses README.md ([78f34fa](https://github.com/FennerEduardo/gherkin-ai-cli/commit/78f34fa5fe41b4cd718b7341aa3a42f8e24e0c71))

## [2.6.2] - 2026-09-15

### Added
- **Docker Validation Script (`validate.sh`):** C# and .NET generators now emit a `validate.sh` script to verify compilation cleanly inside an isolated Docker container without relying on host SDKs.
- **Git Commit Suggester:** `ghk generate` now intelligently outputs a draft commit message in `.ghe/suggested_commit.md` documenting the scaffolds, features generated, and CI validations.
- **Atomic Concurrency Handlers (C#):** Replaced in-memory Idempotency and Outbox implementations with robust PostgreSQL atomic locks (`FOR UPDATE SKIP LOCKED` and `TryAddAsync`).

### Changed
- **BDD Framework Migration:** Replaced deprecated `SpecFlow.xUnit` with `Reqnroll.xUnit` as the standard BDD C# framework for generated step definitions.
- **Improved C# Scaffolding:** Cleaned up stubs (`Task.CompletedTask`) and replaced them with functional Entity Framework Core snippets (`ApplicationDbContext`, DbSets) and explicit Scaffolding exceptions to pass the internal Anti-Stub Guardrail.
- **Dynamic Brokers:** `preset-csharp-dotnet.ts` now injects `MassTransit` configuration (RabbitMQ vs SQS) dynamically based on `gherkin-ai.config.json` instead of hardcoding.
- **Docker Compose Security:** Database passwords are no longer hardcoded in `docker-compose.yml`; the generator now uses shell variables (`${POSTGRES_PASSWORD:-dev_password}`).

### Fixed
- **CS0111 Step Duplication:** C# Step Definitions generator now uses a `Set` to prevent duplicate method generation when scenarios share the same BDD steps.
- **MediatR Contract Constraints:** Fixed `IRequest` inheritance bounds for Commands and Queries in C# contracts to satisfy MediatR `IRequestHandler` type constraints.
- **AWS CDK Naming Bug:** Fixed PascalCase conversion for project names with hyphens (e.g., `transactional-system` -> `TransactionalSystemInfrastructureStack`) to prevent invalid TS identifiers in CDK.
- **Artifact Sprawl:** Forced default `outputDir` in config to `./` to prevent split-brain architecture where `.feature` files live in the root and code lives inside a nested `generated-specs` folder.
- **TS Leak in C#:** Prevented Node.js/Zod `contracts.ts` files from being incorrectly emitted into C# project trees.

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
