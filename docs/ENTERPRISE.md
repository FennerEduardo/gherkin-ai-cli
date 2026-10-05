# Running gherkin-ai in an organization

This guide is for platform, security and developer-experience teams rolling `gherkin-ai` out to many developers and CI pipelines. It covers configuration, LLM providers, networking, credentials, the CLI contract for automation, the MCP server, audit, and what is supported.

- [1. Configuration layers and organization policy](#1-configuration-layers-and-organization-policy)
- [2. LLM providers](#2-llm-providers)
- [3. Credentials](#3-credentials)
- [4. Corporate network: proxy and TLS inspection](#4-corporate-network-proxy-and-tls-inspection)
- [5. Automation contract: exit codes and `--json`](#5-automation-contract-exit-codes-and---json)
- [6. Agent-driven code changes](#6-agent-driven-code-changes)
- [7. MCP server](#7-mcp-server)
- [8. Web Studio](#8-web-studio)
- [9. Audit trail and telemetry](#9-audit-trail-and-telemetry)
- [10. Plugins](#10-plugins)
- [11. Stack support tiers](#11-stack-support-tiers)
- [12. CI integration](#12-ci-integration)
- [13. Verifying releases](#13-verifying-releases)
- [14. Agent firewall](#14-agent-firewall)
- [15. Delivery risk](#15-delivery-risk)
- [16. Traceability graph and Spec Kit](#16-traceability-graph-and-spec-kit)
- [17. Test sandbox, runtime kernel and observability](#17-test-sandbox-runtime-kernel-and-observability)
- [18. Measuring value: A/B benchmark](#18-measuring-value-ab-benchmark)

---

## 1. Configuration layers and organization policy

Configuration is resolved from five layers. Later layers override earlier ones:

| # | Layer | Location |
|---|-------|----------|
| 1 | defaults | built in |
| 2 | **organization** | `$GHK_ORG_CONFIG`, else `/etc/gherkin-ai/config.json` (Windows: `%ProgramData%\gherkin-ai\config.json`) |
| 3 | user | `$GHK_USER_CONFIG`, else `~/.gherkin-ai/config.json` |
| 4 | project | `./gherkin-ai.config.json`, or `-c <file>` |
| 5 | environment | `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `GHK_*`, provider variables |

Every layer is validated against a JSON Schema (`schemas/config.schema.json`, also printed by `ghk config schema`). Add `"$schema": "https://unpkg.com/gherkin-ai/schemas/config.schema.json"` to get editor completion. An invalid file stops the CLI with exit code `3` and the failing field path.

**Locking settings.** The organization layer can declare `locked` paths. Lower layers cannot change them; attempts are ignored and reported as warnings.

```json
{
  "llm": {
    "provider": "azure-openai",
    "azure": { "endpoint": "https://contoso-ai.openai.azure.com", "deployment": "gpt-4o-prod", "apiVersion": "2024-10-21" },
    "allowedProviders": ["azure-openai"],
    "allowedModels": ["gpt-4o*"],
    "timeoutMs": 120000,
    "budget": { "maxTokensPerRun": 200000 }
  },
  "network": { "caFile": "/etc/ssl/certs/contoso-root.pem" },
  "telemetry": { "enabled": true },
  "audit": { "enabled": true },
  "mcp": { "allowWrite": false },
  "policy": { "allowUnattendedWrites": false, "protectedBranches": ["main", "release"], "redactPii": true },
  "plugins": { "allow": ["@contoso/ghk-plugin-standards"] },
  "locked": ["llm.allowedProviders", "llm.allowedModels", "audit.enabled", "mcp.allowWrite", "plugins.allow", "policy"]
}
```

Inspect the effective configuration and where each value came from:

```bash
ghk config show --sources        # value -> layer
ghk config validate --json       # for CI
```

## 2. LLM providers

Set `llm.provider` (or `LLM_PROVIDER`). If nothing is configured the CLI infers a provider from the environment, and falls back to local Ollama.

| Provider | `llm.provider` | Credentials | Required settings |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | – |
| OpenAI-compatible gateway (LiteLLM, internal proxy) | `openai-compatible` | `LLM_API_KEY` (or `OPENAI_API_KEY`) | `llm.baseUrl` |
| Azure OpenAI | `azure-openai` | `AZURE_OPENAI_API_KEY`, or Microsoft Entra ID | `llm.azure.endpoint`, `llm.azure.deployment` |
| Anthropic (Claude API) | `anthropic` | `ANTHROPIC_API_KEY` | – |
| Amazon Bedrock | `bedrock` | standard AWS chain (profile, SSO, env, IRSA/instance role) | `llm.bedrock.region` or `AWS_REGION` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | – |
| Vertex AI (Gemini) | `vertex` | Application Default Credentials | `llm.vertex.project` (`location` defaults to `global`) |
| Ollama (air-gapped) | `ollama` | none | `llm.baseUrl` if not on `localhost:11434` |
| IDE delegation | `ide_delegate` | none | – (no model is called) |

Notes:

- **Entra ID for Azure.** Set `llm.azure.useEntraId: true` and install the optional package `@azure/identity` next to the CLI. It uses `DefaultAzureCredential`.
- **Gateway headers.** `llm.headers` adds headers to every request, for example a cost-center or routing header.
- **Defaults.** Default models live in one table (`src/core/llm/defaults.ts`). Override them with `llm.model` / `LLM_MODEL`.
- **Limits.** `llm.timeoutMs` (default 120 s), `llm.maxRetries` (default 2) and `llm.maxOutputTokens` apply to every provider. Retries cover 408/409/429/5xx and connection errors, honor `Retry-After`, and happen in one place, so they are never multiplied.
- **Budget.** `llm.budget.maxTokensPerRun` stops a run before it exceeds the budget (exit code `5`).
- **Policy.** `allowedProviders`, `allowedModels` and `allowedBaseUrls` accept exact values or a trailing `*`. The project constitution's `allowedLLMProviders` / `forbiddenLLMProviders` are enforced too.
- **Redaction.** Secrets are always redacted from prompts before they leave the machine. Set `policy.redactPii: true` to also redact emails, card numbers, SSNs and IP addresses.

Check what a developer or runner will actually use. Secrets are never printed:

```bash
ghk auth status          # provider, model, credential source, endpoint, proxy, CA file
ghk auth status --json
```

## 3. Credentials

API keys are **never written to disk** by the CLI.

- **CI and servers.** Use the provider's environment variable from the table above, injected from your secret store.
- **Workstations.** Run `ghk login --provider <name>`. It prompts for the key without echoing it and stores it in the OS keychain: macOS Keychain, Windows Credential Manager, or Linux Secret Service, via the optional `@napi-rs/keyring` dependency. Only the provider name is saved, in `~/.gherkin-ai/config.json`. If no keychain is available, the command fails and asks you to use the environment variable instead.
- **Non-interactive.** Use `printenv OPENAI_API_KEY | ghk login --provider openai --api-key-stdin`.
- **Removing keys.** Run `ghk logout [--provider <name>]`.

Key resolution is strictly per provider. A configured `anthropic` provider never receives `OPENAI_API_KEY`. Environment variables take precedence over the keychain.

## 4. Corporate network: proxy and TLS inspection

Node's built-in `fetch` ignores `HTTPS_PROXY`. `gherkin-ai` installs a proxy-aware dispatcher that every provider SDK uses:

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honored, or set `network.proxy` / `network.noProxy`.
- For TLS-inspecting proxies, set `network.caFile` to a PEM bundle. It is trusted in addition to the system roots. `NODE_EXTRA_CA_CERTS` keeps working too.
- Connection failures exit with code `6` and a hint that points at proxy and CA settings.

## 5. Automation contract: exit codes and `--json`

Exit codes are stable across 3.x:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error (unknown flag, missing argument, missing `--project` directory) |
| 3 | configuration error (invalid file, missing credentials for the selected provider) |
| 4 | quality gate failed (`lint`, `validate`, `quality`, `evaluate`, `verify` tests, `pr-review`) |
| 5 | denied by policy (organization allow-lists, protected branch, unattended writes, path outside workspace, token budget) |
| 6 | LLM provider or network failure |
| 7 | specification drift (`converge` below threshold, `diff`) |

With `--json` (global or per command), **stdout carries exactly one JSON document**. Human-readable output goes to stderr.

- Commands with structured results print them, for example `lint`, `converge`, `audit`, `impact`, `config`, `auth status` and `stacks`.
- Every other command prints `{ "ok", "command", "version", "exitCode" }`.
- Errors print `{ "ok": false, "error": { "type", "exitCode", "message", "hint" } }`.

Other behaviour automation can rely on:

- **Non-interactive mode.** `--yes`, `CI=true` or `GHK_NON_INTERACTIVE=true` disable every prompt.
- **No directory guessing.** The CLI never changes directory on its own in CI. Pass `--project <dir>`. Only `init` creates a missing project directory.
- **Output control.** `--quiet` limits output to warnings and errors, `GHK_LOG_LEVEL` sets the level, and `NO_COLOR` is honored.
- **Log files are opt-in.** Set `logging.file`. Files are size-rotated (`logging.maxSizeMb`, `logging.maxFiles`) and secrets are redacted.

## 6. Agent-driven code changes

`ghk verify --auto-fix` and `ghk autopilot` let an LLM propose code. Their defaults are deliberately conservative:

- **Dry run by default.** Changes are written as `.patch` files. Only `--apply` writes source files.
- **CI guard.** In CI, `--apply` is refused unless you pass `--allow-unattended-writes` or set `policy.allowUnattendedWrites: true`.
- **Branch guard.** `--apply` is refused on protected branches (`policy.protectedBranches`, default `main` and `master`) unless you pass `--force-branch`.
- **Workspace guard.** File paths returned by the model are ignored when they point outside the workspace.
- **Agent firewall.** Every file goes through the [agent firewall](#14-agent-firewall). Anything it does not ALLOW is saved to `.ghe/patches/<file>.proposed` for review instead of being written.
- **Audit.** Every allowed or blocked write decision is recorded in the audit trail.

Recommended practice: run the agent loop on a feature branch and review the patch in a pull request.

## 7. MCP server

`ghk mcp` starts a stdio MCP server built on the official `@modelcontextprotocol/sdk`. It follows least privilege:

| Tool level | Examples | Enabled when |
|---|---|---|
| safe (read-only) | `parse_gherkin`, `build_ir`, `lint_specification`, `run_cli_lint`, `run_cli_audit`, `scan_security` | always |
| requires_review (writes project files) | `run_cli_generate`, `run_cli_add`, `run_cli_create`, `run_cli_init` | `mcp.allowWrite: true` |
| destructive (runs tests, LLM changes code) | `run_cli_verify`, `run_cli_autopilot` | `mcp.allowWrite: true` **and** `GHK_ALLOW_DESTRUCTIVE=true` in the server environment |

Tools that are not enabled are not registered, so agents never see them. Every call goes through the same checks:

- Path arguments must resolve inside the workspace (symlinks resolved).
- Written paths are checked by the [agent firewall](#14-agent-firewall). MCP has no human-approval channel, so REQUIRE_APPROVAL is refused like DENY.
- `run_cli_verify` only runs the project's configured `testCommand`. There is no free-form command argument.
- Credentials cannot be set over MCP, and the audit trail cannot be cleared over MCP.
- Command output is captured and returned to the client instead of being written to the protocol stream.
- Each call, including blocked ones, is written to the audit trail with `source: "mcp"`.

`ghk mcp install` writes client configuration that pins the package version (`npx -y gherkin-ai@<version> mcp`).

## 8. Web Studio

`ghk web` binds to `127.0.0.1` and prints a URL containing a random session token. API calls require that token in the `x-ghk-token` header. The server also enforces:

- an exact `Host` match, which defeats DNS rebinding;
- a same-origin `Origin` check;
- workspace path containment on every file endpoint.

Commands run without a shell, and `--apply`, `--project` and `--config` are rejected. Web Studio refuses to start when `CI=true`.

## 9. Audit trail and telemetry

Both are local JSONL files under `telemetry.dir`, default `<workspace>/.gherkin-ai/`. **Nothing is sent over the network.**

| File | Content | Control |
|---|---|---|
| `audit.jsonl` | Security-relevant events: LLM calls, MCP tool calls, agent write decisions, plugin loads, inventory or agent-log clears, Web Studio commands. Fields: `timestamp`, `executionId`, `version`, `user`, `host`, `source`, `action`, `resource`, `status`, `details` | `audit.enabled` (default `true`; lock it at org level) |
| `telemetry.jsonl` | One event per command: duration and exit code. One event per LLM call: provider, model, tokens | `telemetry.enabled`, `GHK_TELEMETRY_DISABLED=true` |

The `details` field is redacted. `executionId` correlates log lines, telemetry and audit records from the same run.

Export for a SIEM:

```bash
ghk audit export --since 7d --format jsonl > ghk-audit.jsonl
ghk audit export --since 2026-10-01 --format csv -o audit.csv
```

CSV export neutralizes spreadsheet formula injection.

## 10. Plugins

Plugins are listed in `plugins.load`, as npm package names or paths relative to the project. When the organization sets `plugins.allow`, anything else is refused with exit code `5`. Relative plugin paths must stay inside the project. Each load is audited. A plugin exports a `GherkinAIPlugin` (as `default` or `plugin`) or a `register(registry)` function.

The 2.x form `"plugins": ["my-plugin"]` is still accepted as `plugins.load`.

## 11. Stack support tiers

```bash
ghk stacks          # or: ghk stacks --json
```

Every target below is **stable**: on every change CI generates a sample project, builds it **and runs its generated test suite** inside the stack's official Docker image (`scripts/golden-build.js`, one CI job per stack). Pending BDD steps are allowed; failing or erroring tests are not.

| Kind | Stack | Build / test toolchain (image) |
|---|---|---|
| backend | TypeScript · NestJS 11 + Prisma 6 (default, CommonJS) | npm, Jest, cucumber-js (`node:24`) |
| backend | TypeScript · NestJS 12 + Prisma 7 (ES modules) | npm, Jest (ESM), cucumber-js via tsx (`node:24`) |
| backend | TypeScript · NestJS 12 + Prisma 6 (ES modules) | npm, Jest (ESM), cucumber-js via tsx (`node:24`) |
| backend | TypeScript · NestJS 11 + Prisma 7 (CommonJS, MariaDB adapter) | npm, Jest, cucumber-js (`node:24`) |
| backend | TypeScript · Express 5 (+ Prisma 6 or 7) | npm, Jest, cucumber-js (`node:24`) |
| backend | C# · ASP.NET Core 8 + EF Core | dotnet, xUnit, Reqnroll (`dotnet/sdk:8.0`) |
| backend | Java 17 · Spring Boot 3 (Maven) | Maven, JUnit 5, Cucumber-JVM (`maven:3.9-temurin-17`) |
| backend | Kotlin · Spring Boot 3 (Gradle) | Gradle, JUnit 5, Cucumber-JVM (`gradle:8.10-jdk17`) |
| backend | Python · FastAPI + SQLAlchemy | pip, pytest, pytest-bdd (`python:3.12`) |
| backend | Python · Django + DRF | pip, pytest, pytest-bdd (`python:3.12`) |
| backend | Go · chi | go vet, go test, godog (`golang:1.22`) |
| backend | PHP · Laravel 13 | Composer, PHPUnit 12, Behat (`composer:2`) |
| backend | Ruby · Rails 8 (API) | Bundler, RSpec, Cucumber (`ruby:3.3`) |
| backend | Elixir · Phoenix | mix, ExUnit (`elixir:1.17`) |
| backend | Rust · Axum | cargo test (`rust:1.99`) |
| backend | Dart · Flutter (standalone app) | flutter analyze, flutter test |
| frontend | React 19 · Redux Toolkit · Vite | Vitest (`node:24`) |
| frontend | Vue 3 · Pinia · Vite | Vitest (`node:24`) |
| frontend | Angular 22 · NgRx Signals (zoneless) | `@angular/build` unit-test (Vitest) |
| frontend | Next.js 16 (App Router) | next build, Vitest |
| frontend | React Native · Expo SDK 57 | jest-expo |
| frontend | Flutter | flutter test |
| frontend | Phoenix LiveView (with the Phoenix backend) | LiveViewTest |
| contracts | gRPC (`contracts.grpc: true`) | `buf build` + `buf lint` |
| contracts | GraphQL SDL (`contracts.graphql: true`) | graphql-js schema validation |

Backends also include the **runtime kernel** (PostgreSQL, RabbitMQ, OpenTelemetry). Its integration suite (IT1–IT7) runs against real PostgreSQL 17 and RabbitMQ 4 containers in every backend golden build. See [section 17](#17-test-sandbox-runtime-kernel-and-observability). Frontend API clients send a W3C `traceparent` header, and their generated tests assert it.

The opt-in AWS CDK app (`infrastructure.awsCdk`) has its own golden build: `npm test` with CDK assertions, then `cdk synth`.

Every generated project shares one behavioral kernel derived from the feature: an aggregate with one method per command, unit tests (initial state, each command records one event and bumps the version, a command without an id is rejected), an HTTP contract test where the stack exposes an API (`POST /api/v1/<feature>/{id}/<command>` → 201), and BDD step definitions bound to the `.feature` file and generated as *pending*. Saga, outbox, idempotency, multitenancy and telemetry infrastructure is generated on top of that kernel.

### NestJS and Prisma versions

NestJS 11 and Prisma 6 remain the defaults. Projects opt into the newer majors in `stack`:

```json
{ "stack": { "framework": "nestjs", "frameworkVersion": "12", "orm": "prisma", "ormVersion": "7" } }
```

| Setting | Values | Effect on the generated project |
|---|---|---|
| `frameworkVersion` (NestJS) | `11` (default), `12` | NestJS 12 ships only as ES modules. The project is generated with `"type": "module"` and `.js` import specifiers. Jest runs in ESM mode and cucumber-js loads steps through `tsx`. |
| `ormVersion` (Prisma) | `6` (default), `7` | The `prisma-client` generator writes the client into `src/generated/prisma` (run `npx prisma generate`). The connection URL moves to `prisma.config.ts`. `PrismaService` gets the driver adapter for `stack.database`: `@prisma/adapter-pg`, `@prisma/adapter-mariadb` (MySQL/MariaDB) or `@prisma/adapter-better-sqlite3`. Prisma 7 does not support MongoDB. |

`ghk init --frameworkVersion 12 --ormVersion 7` sets them, and `ghk upgrade` points out the newer majors without changing the default. Each of the four NestJS combinations, and Express with Prisma 7, has its own golden build.

Frontends are generated in `./frontend` next to the backend. Contracts are generated in `./contracts`:

```json
{ "contracts": { "grpc": true, "graphql": true } }
```

Any other language/framework combination is **experimental** (contracts and prompts only); `ghk init` and `ghk generate` warn about it.

Run the golden builds locally with Docker:

```bash
npm run build
node scripts/golden-build.js --list        # stacks and images
node scripts/golden-build.js java vue      # selected stacks (all when omitted)
```

## 12. CI integration

Use the composite action and **pin the version**:

```yaml
- uses: FennerEduardo/gherkin-ai-cli/.github/actions/audit@v3.0.0
  with:
    version: 3.0.0
    lint-threshold: 80
    converge-threshold: 80
```

Or call the CLI directly:

```bash
npx --yes gherkin-ai@3.0.0 lint --threshold 80 --json > ghk-lint.json        # exit 4 below threshold
npx --yes gherkin-ai@3.0.0 converge --threshold 80 --json > ghk-converge.json # exit 7 below threshold
npx --yes gherkin-ai@3.0.0 risk --base origin/main --fail-on HIGH --json        # exit 4 at HIGH or above
```

## 13. Verifying releases

Releases are published from GitHub Actions with **npm provenance**. Every GitHub Release carries a CycloneDX SBOM (`sbom.cdx.json`).

```bash
npm audit signatures          # verifies registry signatures and provenance attestations
```

The published package contains `dist/`, `bin/`, `docs/`, `schemas/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `SECURITY.md`.

## 14. Agent firewall

One decision point for what an agent may do, whichever agent it is: an MCP client, `verify --auto-fix`, `autopilot`, or an IDE agent through a hook.

| Action | Target | Decision rules (in order) |
|---|---|---|
| `write` | file path | outside the workspace → DENY · `denyPaths` → DENY · outside the feature's impact scope → DENY · not in `allowPaths` (when set) → DENY · existing `gherkin-ai.config.json` or `approvalPaths` → REQUIRE_APPROVAL · otherwise ALLOW |
| `execute` | command line | any `denyCommands` match anywhere in the line → DENY · every segment (`&&`, `;`, `\|`) starts with an `allowCommands` prefix → ALLOW · otherwise REQUIRE_APPROVAL |
| `network` | host or URL | `allowHosts` (exact or `*.domain`) → ALLOW · otherwise DENY |
| `secret` | variable or file name | `allowSecrets` → ALLOW · secret-like names (`*KEY*`, `*TOKEN*`, `*PASSWORD*`, `.env*`, keys) → DENY |
| `tool` | MCP tool | destructive tools → REQUIRE_APPROVAL · otherwise ALLOW |

Built-in lists apply even with no configuration:

- **Never writable:** `.env*`, private keys, `**/secrets/**`, `.git/**`, `.npmrc`, cloud credentials, the audit trail and `.ghkgovernance.yaml` (an agent cannot edit its own policy).
- **Approval required:** CI workflows, migrations, `schema.prisma`, Dockerfiles, compose files, infrastructure (`*.tf`, k8s, helm) and `package.json`.
- **Denied commands:** `sudo`, `git push`, `npm publish`, `curl`, `ssh`, `kubectl`, `terraform apply` and others.
- **Allowed commands:** read-only commands, and the build and test commands of every supported stack plus your `testCommand`.

Configure it in `policy.firewall`. Lock it at organization level with `"locked": ["policy.firewall"]`:

```json
{
  "policy": {
    "firewall": {
      "allowPaths": ["services/**", "tests/**", "features/**"],
      "denyPaths": ["identity/**", "production-config/**"],
      "approvalPaths": ["services/payments/**"],
      "allowCommands": ["make test"],
      "allowHosts": ["registry.npmjs.org"],
      "allowSecrets": [],
      "enforceFeatureScope": true
    }
  }
}
```

The legacy `.ghkgovernance.yaml` keys (`allowedPaths`, `protectedPaths`, `requireHumanApprovalOn`) are still read.

**Feature scope.** When a feature is given (`--feature`), writes are limited to the files and directories that implement or test that feature's commands, events and endpoints. That set comes from the [traceability graph](#16-traceability-graph-and-spec-kit). Test and spec directories also stay writable. Everything else is denied.

```bash
ghk firewall check --write services/payments/refund.ts --feature features/refunds.feature   # exit 0 ALLOW, 5 otherwise
ghk firewall check --exec "npm test && git push"                                            # DENY (git push)
ghk firewall policy --feature features/refunds.feature                                       # effective rules
```

**Claude Code.** Register the firewall as a `PreToolUse` hook so edits, shell commands, web fetches, reads of secret files and MCP calls are checked before they run. A DENY blocks the tool call and REQUIRE_APPROVAL asks the user. On ALLOW the hook prints nothing, so Claude Code's own permission rules still apply.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash|WebFetch|Read|mcp__.*", "hooks": [{ "type": "command", "command": "npx --yes gherkin-ai@3.0.0 firewall hook" }] }
    ]
  }
}
```

Every decision is written to the audit trail as `firewall:<action>`, with the verdict, the rule and the agent.

## 15. Delivery risk

`ghk risk` rates a change as LOW, MEDIUM, HIGH or CRITICAL rather than pass/fail.

**What it assesses**, in order of precedence:

1. the git diff against `--base`, plus any uncommitted changes;
2. an explicit `--files` list;
3. the working tree;
4. the whole specification, when there are no changes.

**How it scores.** Six weighted dimensions, each listing its evidence:

| Dimension | Weight | Evidence |
|---|---|---|
| Security | 25% | authorization rules in the specs, security-sensitive paths changed (auth, crypto, tokens, tenants…), hardcoded secrets |
| Business criticality | 15% | `@critical` specs, `policy.risk.criticalPaths`, payment / billing / order code |
| Change radius | 25% | files and areas changed, contracts and schemas changed |
| Test weakness | 20% | coverage report, tests changed alongside the source changes |
| Contract drift | 10% | spec-to-code convergence (`ghk converge`) |
| Architecture drift | 5% | infrastructure, CI, migrations, dependency manifests |

**Overrides.** Hardcoded secrets are never rated below HIGH. A change that is security-sensitive, business-critical and untested is always CRITICAL.

**Approval.** `policy.risk.requireApprovalAt` (default `HIGH`) sets the level that requires human approval. `--fail-on <level>` makes the command a CI gate that exits with code `4`. `ghk quality`, `ghk autopilot` and the MCP risk tool use the same engine.

```bash
ghk risk --base origin/main                  # scorecard with evidence
ghk risk --base origin/main --fail-on HIGH   # CI gate
```

## 16. Traceability graph and Spec Kit

`ghk graph` builds a deterministic graph from the IR of every `.feature` file and a scan of the source tree. It links feature → scenario → command → event and endpoint, and connects each of them to the files that implement them and the tests that reference them. Matching covers every naming style: `PlaceOrder`, `placeOrder`, `place_order` and `place-order`.

```bash
ghk graph                                   # summary: what is not implemented or not tested
ghk graph --trace OrderPlaced               # requirement → code → tests for one symbol
ghk graph --scope features/orders.feature   # files a change to this feature may touch
ghk graph --format mermaid -o docs/graph.mmd
```

The graph does not need an LLM or a database. It ignores dependency and build directories, and large repositories can be capped with a file limit.

**GitHub Spec Kit.** gherkin-ai can sit below Spec Kit as the executable, verifiable layer:

- **`ghk speckit import`** turns `specs/NNN-name/spec.md` into `.feature` files.
  - Each acceptance scenario becomes a scenario tagged `@US<n> @P<n>`.
  - FR-### requirements and edge cases are kept in the feature description.
  - `[NEEDS CLARIFICATION]` markers are reported.
- **`ghk speckit export`** goes the other way, and round-trips the user stories, priorities and requirements.

## 17. Test sandbox, runtime kernel and observability

**`ghk verify --docker`** runs the tests in the stack's toolchain image with these restrictions:

- no network (`--docker-network bridge` when dependencies must be downloaded);
- 2 GB of memory, 2 CPUs and 512 processes;
- all capabilities dropped, `no-new-privileges` and a read-only root filesystem;
- only the project mounted, and no host shell.

Override the limits in `sandbox.*`.

**Runtime kernel.** Every generated backend includes the same runtime, specified in [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md):

- PostgreSQL persistence, with idempotent commands and an outbox;
- a RabbitMQ relay with publisher confirms and `SKIP LOCKED` leases;
- an inbox consumer with a dead-letter queue;
- a saga orchestrator;
- W3C trace context across the command, publish and consume spans.

Its integration suite (IT1–IT7) is excluded from the default test run and runs with the stack's integration command.

**OpenTelemetry.** Spans use each language's official OpenTelemetry SDK and the global tracer provider. Configure the exporter with the standard `OTEL_*` variables. Generated frontends send a `traceparent` header with every API call. If the frontend and the API are served from different origins, add `traceparent` to the API's CORS allowed headers, next to `Content-Type` and `X-Tenant-Id`.

## 18. Measuring value: A/B benchmark

`ghk bench` answers whether an agent does better with gherkin-ai than without it, on your own task and with your own agent.

**Setup.** `ghk bench init <dir>` scaffolds the task folder:

- `bench.json`: the agent command and the checks;
- `REQUIREMENTS.md`;
- `features/`;
- an optional `seed/` project;
- hidden `acceptance/` tests.

**How a run works.** `ghk bench run <dir>` runs two arms with the same agent command, prompt template, timeout and machine:

- **control** gets the requirements only;
- **ghk** also gets the features and the deterministic `ghk generate` output.

The acceptance tests are copied in only after the agent finishes.

**Scoring.** Both arms are scored by the same deterministic checks:

- build, tests and hidden acceptance tests;
- spec-to-code convergence;
- files changed and agent time.

Results are averaged over N repetitions and written to `report.json` and `report.md`.

The harness never calls a model itself, and `--dry-run` prepares the workspaces without starting the agent. Model costs come only from the agent command you configure.
