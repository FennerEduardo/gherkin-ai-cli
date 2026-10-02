# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.0.0-beta.1] - Unreleased

Enterprise-readiness release, driven by the 2.6.5 reviews. Contains breaking changes: see `docs/MIGRATION-3.0.md`. For operators: `docs/ENTERPRISE.md`.

### Added
- **Layered, validated configuration:** defaults → organization (`GHK_ORG_CONFIG`) → user → project → environment, validated with zod; organization `locked` paths; published JSON Schema (`schemas/config.schema.json`); `ghk config show|validate|schema`.
- **LLM providers:** Azure OpenAI (API key or Entra ID), Amazon Bedrock, Google Gemini and Vertex AI, OpenAI-compatible gateways (`llm.baseUrl` + `llm.headers`), alongside OpenAI, Anthropic and Ollama. Per-request timeouts, a single retry layer honoring `Retry-After`, per-run token budgets, and allow-lists for providers, models and endpoints.
- **Corporate networking:** `HTTPS_PROXY`/`NO_PROXY` and `network.proxy` for all providers; extra trusted CAs via `network.caFile`.
- **Credentials:** OS keychain storage (`ghk login`, `--api-key-stdin`), `ghk logout`, `ghk auth status`.
- **Automation contract:** documented exit codes (2 usage, 3 config, 4 gate, 5 policy, 6 provider, 7 drift); `--json` prints exactly one JSON document on stdout for every command; `--quiet`; `NO_COLOR`.
- **Audit and telemetry:** structured `audit.jsonl` and `telemetry.jsonl` (local only) with execution ids; LLM calls, MCP calls, agent write decisions and plugin loads are audited; `ghk audit export --format jsonl|csv --since`.
- **Agent write guards:** `autopilot` is dry-run by default (`--apply`); `--apply` is refused in CI (`--allow-unattended-writes`) and on protected branches (`--force-branch`).
- **Governed plugins:** `plugins.load` with an organization allow-list (`plugins.allow`).
- **Every stack is stable:** 13 backends (NestJS, Express, ASP.NET Core, Spring Boot Java and Kotlin, FastAPI, Django, Go, Laravel 13, Rails 8, Phoenix, Axum, Flutter), 7 frontends (React, Vue, Angular 22, Next.js 16, React Native/Expo 57, Flutter, Phoenix LiveView) and gRPC/GraphQL contracts. CI generates each one and builds it and runs its generated tests in the stack's official Docker image (`scripts/golden-build.js`); `ghk stacks` lists them.
- **Shared domain kernel:** every stack renders the same aggregate, unit tests, HTTP contract test and pending BDD steps bound to the feature file.
- **Opt-in gRPC and GraphQL contracts** (`contracts.grpc`, `contracts.graphql`), validated with buf and graphql-js.
- **Web Studio works offline:** Tailwind and Font Awesome are bundled instead of loaded from a CDN; Playwright end-to-end tests assert that no external request is made.
- **CI/release:** OS × Node 22/24 matrix, blocking `npm audit`, golden builds, CLI contract tests against the built binary, and a release workflow with npm provenance and a CycloneDX SBOM.
- `--threshold` for `lint` and `converge`.

### Changed
- **Startup time** reduced from about 0.7 s to about 0.15 s: command handlers and networking are loaded lazily.
- **MCP server rebuilt on `@modelcontextprotocol/sdk`:**
  - Read-only by default; write tools need `mcp.allowWrite`, and destructive tools also need `GHK_ALLOW_DESTRUCTIVE`.
  - Central path containment, agent policy and auditing on every call.
  - Command output is captured instead of corrupting the stdio protocol.
  - Commands are invoked in-process, so the server works when installed globally.
  - `ghk mcp install` pins the package version.
- **Web Studio:** per-session token, exact Host and Origin checks, path containment, no shell execution.
- **Security patterns unified** in `src/core/security`. Secrets are redacted from LLM prompts, log files and audit records.
- **Logger:** levels, stderr for diagnostics, opt-in rotated log file; no longer writes `.ghe/logs` into the working directory on every run.
- **Single version source:** the CLI banner, `--version` and the MCP `serverInfo` all read the version from `package.json`. The MCP server previously reported a hardcoded value.
- **Package contents:** `CHANGELOG.md`, `LICENSE`, `SECURITY.md` and `schemas/` are now published.

### Fixed
- **Credential leak between providers:** a key belonging to another provider could be sent to the selected one (for example, the OpenAI key sent to Anthropic). `--apiKey` was silently ignored.
- **NestJS idempotency race:** expired or failed keys could be re-claimed by two concurrent requests.
- **Generated NestJS projects did not compile:**
  - inconsistent `PrismaService` paths;
  - missing dependencies;
  - escaped `\n` inside step definitions;
  - missing Prisma models;
  - wrong Prisma delegate casing.
- **Generated .NET projects did not compile:**
  - non-existent `Microsoft.EntityFrameworkCore.PostgreSQL` package;
  - invalid root namespace for hyphenated project names;
  - Aspire AppHost compiled into the API project;
  - wrong command namespaces;
  - missing event record;
  - missing OpenTelemetry, Testcontainers, ServiceDiscovery and Swashbuckle packages.
- **Unhandled async errors:** `program.parse()` → `parseAsync()`.
- **Help and workspace detection:** workspace detection no longer prompts or changes directory for `--help` or in CI. `--project` no longer creates directories (except for `init`).
- **Web Studio path traversal:** `/api/features/*` and `/api/file` were affected (sibling-prefix bypass).
- **Portability:** `verify` no longer shells out to `sleep`, which is not available on Windows.
- **Dependency vulnerabilities:** resolved transitive advisories (brace-expansion, fast-uri, hono, ip-address).

### Fixed (generation)
- Localized features (`# language: es` or any leading comment) were parsed as Markdown, producing names like `LanguageEs`.
- Identifiers kept broken fragments of accented words (`CreaciN`); one-letter words were glued to the next (`yrenderizado`).
- Decimal amounts before a quoted value produced invalid field types (`00DTO`).
- Connection URLs without credentials (`amqp://rabbitmq:5672`) were rejected as leaked secrets.

### Removed
- **Node.js 20 support** (end-of-life); the CLI requires Node.js 22.12 or later.
- Superseded frontend generators (`react-generator`, `vue-pinia-generator`, `angular-ngrx-generator`, `angular-signalr-service`) and the classic NgRx store mode.
- `ghk login --apiKey/--token/--user/--endpoint/--server` and the `auth` alias of `login`.
- MCP tool `run_cli_login`; `clear` on `run_cli_audit`.
- Legacy hook manager `src/core/hooks.ts`.
- Stray development files from the repository root (`cdk-test-out.ts`, `scratch/`, `specs/`, pack logs).

## [2.6.5] - 2026-09-28

> Published to npm without a changelog entry; reconstructed from git history.

### Added
- Kotlin contract generation integrated with the contract generation system.
- Markdown EARS parser (`src/core/parsers/markdown-ears-parser.ts`).
- Plugin management in `ghk generate`.
- AWS CDK infrastructure stack (SNS, SQS, DynamoDB, EKS, Secrets Manager).
- Multi-tenancy support for Go, Java, Python and NestJS generators; Prisma multi-tenancy and relation tracking.
- OpenTelemetry Jaeger exporter and additional instrumentations.
- `ghk audit` HTML report generation.
- Coverage analysis in `ghk quality` and `--isolated` mode in `ghk verify`.

### Changed
- NestJS Outbox and Saga infrastructure with atomic claims and idempotency patterns.
- API keys are no longer persisted in `auth.json`; Row-Level Security enforcement and governance checks for destructive MCP operations.
- Deprecation warnings for manual prompt workflows.

## [2.6.4] - 2026-09-16

### Fixed
- README explicitly included in the npm bundle.

### Docs
- Multi-stack evaluation report (`docs/EVALUATION_REPORT.md`) and updated command documentation.

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
