# Adopting gherkin-ai in an existing project

This guide is for teams that already have a code base, a CI pipeline and a release process, and want to add gherkin-ai without stopping delivery. It covers the order of adoption, what each step changes in the repository, and the gates to turn on along the way.

Upgrading a project that was generated with an earlier gherkin-ai version is a different task; see [MIGRATION-3.2.md](MIGRATION-3.2.md).

## Choose how deep to go

gherkin-ai does not have to generate code to be useful. Pick the level that fits each service; different services in the same repository can sit at different levels.

| Level | You get | You do not get | Fits |
|---|---|---|---|
| **1. Specifications and gates** | Linted `.feature` files, the semantic model, industry rules, delivery risk, the traceability graph, PR reports, MCP and the agent firewall | Generated code | Any stack, including stacks gherkin-ai does not generate |
| **2. Contracts and agent prompts** | Level 1, plus OpenAPI / AsyncAPI, an ADR and agent prompts per feature, next to your code | A runnable service | A module you keep writing by hand, or with an agent |
| **3. A generated service next to your code** | Level 2, plus a verified service: domain kernel, runtime kernel (PostgreSQL, outbox, inbox, sagas, tracing), HTTP layer, tests, Dockerfile, optional Terraform, Helm and CI | — | A new bounded context, or one you are extracting from a monolith |

Most teams start with level 1 on one service, move the services they build next to level 3, and leave the rest at level 1.

## 0. No configuration: the governance commands only

Before any of the steps below, you can try level 1 on a repository as it is: no `ghk init`, no generated file.

- **What runs:** `lint`, `validate`, `converge`, `risk`, `graph`, `impact`, `diff` and `firewall`, on the `.feature` files in `features/` or `specs/`.
- **What they assume:** the stack `ghk detect --json` reports (language, framework, test runner), not gherkin-ai's defaults.
- **What they leave out:** without a configuration, an inventory or a constitution, `converge` reports *Contract Coverage* and *Architecture Compliance* as `n/a` and scores the rest. `--openapi <file>` measures your own contract instead: a command counts as covered by an operation whose `operationId` names it (`placeOrder`) or whose path ends with its verb (`POST /orders/{id}/cancel`).
- **What they write:** nothing in the repository. Telemetry and audit go to `~/.gherkin-ai/workspaces/`, and the semantic-model cache (`.ghe/cache/`) ignores itself in git.
- **Failing closed:** a project with no feature files exits 2 in `lint` and `converge` (`--allow-empty` accepts it), so a job pointed at the wrong directory does not pass.

```yaml
# .github/workflows/specifications.yml: governance only, no gherkin-ai configuration in the repository
name: specifications
on: pull_request
jobs:
  gherkin-ai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v5
        with: { node-version: '24' }
      - run: npx -y gherkin-ai@3.2.2 lint --threshold 80
      - run: npx -y gherkin-ai@3.2.2 converge --openapi docs/openapi.json --threshold 80
      - run: npx -y gherkin-ai@3.2.2 risk --base origin/${{ github.base_ref }} --fail-on HIGH
```

`tests/golden/brownfield.test.ts` runs these commands on an Express and a Spring service in every CI run. When the team wants gherkin-ai's own contracts, architecture rules and industry profile, continue with step 1.

## 1. Install and pin

```bash
npm install --save-dev --save-exact gherkin-ai@3.2.2   # or a pinned global install on the build agents
npx ghk --version
```

- **Pin an exact version** in the repository, in CI (`npx --yes gherkin-ai@3.2.2`) and in MCP clients (`ghk mcp install` pins it). An unpinned install changes generated output and lint scores without a commit.
- **Requirements:** Node.js 22.19 or later. Docker for `ghk verify --docker`, `--services` and the golden recipes.
- **Organization settings:** providers, proxies, locked keys and allow-lists belong in the organization configuration layer, not in each repository ([ENTERPRISE.md §1](ENTERPRISE.md#1-configuration-layers-and-organization-policy)). Set it up once, before the first team starts.

## 2. Create the configuration

Commit what you have first: the commands below write files at the repository root.

```bash
ghk detect                   # detects the stack and writes gherkin-ai.config.json from it
ghk config show --sources    # check the result: which layer set each value
```

`ghk detect` reads the build files at the directory root: `package.json`, `pom.xml` / `build.gradle(.kts)` (including Quarkus, Micronaut and Ktor builds), `go.mod`, `Cargo.toml`, `pyproject.toml` / `requirements.txt` / `manage.py`, `composer.json`, `Gemfile`, `mix.exs` (Phoenix, and LiveView as its frontend), `pubspec.yaml`, and for .NET `Program.cs`, `appsettings.json` or a `.csproj` up to two directories down. It sets `outputDir` to `./generated-specs`, so generated code never lands in your `src/` or `app/`. For .NET it takes the database from the project's packages (PostgreSQL unless only SQL Server is referenced); the runtime kernel needs PostgreSQL. Edit the file for what cannot be detected:

```json
{
  "$schema": "https://unpkg.com/gherkin-ai/schemas/config.schema.json",
  "projectName": "billing",
  "specDir": "./features",
  "outputDir": "./generated-specs",
  "architecture": "hexagonal",
  "stack": { "language": "java", "framework": "quarkus", "database": "postgres", "messaging": "rabbitmq" },
  "industry": { "id": "banking" }
}
```

- **`specDir`** is where the `.feature` files live. Keep them in the repository, reviewed like code.
- **`outputDir`** is where `ghk generate` writes. In an existing repository, keep it a dedicated directory (`./generated-specs` or `./services/<name>`), never the root of a hand-written application.
- **`ghk init` is for new projects.** It refuses (exit 2) when `gherkin-ai.config.json` already exists; `ghk init --force` replaces the configuration and the governance policy, so commit first. In an existing repository use `ghk detect` once, then edit the file.
- **`.ghkgovernance.yaml` is yours to edit.** `generate` refreshes it from the configuration while it is unedited (it carries a checksum of its content); once you edit it, it is kept and the new version is written to `.ghkgovernance.yaml.ghk-new`.
- **Monorepos:** one `gherkin-ai.config.json` per service directory. `ghk lint --all` and `ghk converge --all` cover every project in the repository; `--project <dir>` targets one.

## 3. Specify the behavior you already have

Start with one bounded context that changes often. Write features for what it does today (characterization), then for the change you are about to make.

```bash
ghk create                                  # guided, or write the .feature file by hand
ghk speckit import                          # if you already use GitHub Spec Kit (specs/NNN-*/spec.md)
ghk lint -f features/invoicing.feature
ghk lint --explain-ir -f features/invoicing.feature
```

- **Name the model explicitly.** `@aggregate:Invoice @command:IssueInvoice @event:InvoiceIssued` fixes the names the generator, the graph and the agents use, in any Gherkin dialect. Without them, commands are inferred from English verbs; non-English features fall back to a generic `process_<aggregate>` command (lint rule GHK016). `--explain-ir` shows where every name comes from.
- **One feature per aggregate.** The runtime kernel covers one aggregate per feature; a service can hold several features.
- **Cover the failure paths.** Lint expects negative scenarios (GHK009) and, for money and claims, the duplicated-request and denial paths. Tag a negative scenario `@negative` when its wording is not recognized.
- **Link existing code to the specification** so `ghk graph`, `ghk risk` and `ghk impact` see it:
  - a `ghk:implements <Symbol>` comment on the class or function that implements a command or event;
  - a `ghk:trace feature=features/invoicing.feature` comment for any other file;
  - `@trace:<Symbol>` tags on a scenario.

  Code that does not use the domain names of the specification is not linked automatically.

## 4. Gate pull requests, then tighten

Add the gates in report-only form, read the results for a sprint, then make them blocking. The exit codes are stable across 3.x ([ENTERPRISE.md §5](ENTERPRISE.md#5-automation-contract-exit-codes-and---json)).

```yaml
# .github/workflows/specifications.yml
name: Specifications
on: [pull_request]
jobs:
  gherkin-ai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0                  # ghk risk compares with the base branch
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Specification quality, convergence and delivery risk on the pull request
        run: npx --yes gherkin-ai@3.2.2 report --provider github --base origin/${{ github.base_ref }} --threshold 70 --fail-on CRITICAL
      - name: Upgrade check
        run: npx --yes gherkin-ai@3.2.2 upgrade --check
```

`ghk report` writes annotations on the changed `.feature` lines and a job summary, with no token and no extra permission (`--provider gitlab` writes a Code Quality report for merge requests).

| Gate | Start | Target | Exit code when it fails |
|---|---|---|---|
| `lint --threshold` | the current average score, rounded down | 80 | 4 |
| `converge --threshold` (level 3 services) | report only | 80 | 7 |
| `risk --fail-on` | `CRITICAL` | `HIGH`, after calibrating the weights with `ghk risk --calibrate --write` on your history | 4 |
| `upgrade --check` | from the start | — | 4 while required changes are pending |

`ghk init --enterprise` writes a complete gate workflow (`.github/workflows/gherkin-ai-gate.yml`) if the repository has none. `deploy` with `ci.provider` generates full CI/CD pipelines for generated services ([DEPLOYMENT.md](DEPLOYMENT.md)).

## 5. Turn on the industry profile

If the service belongs to a regulated or standardized industry, opt in to its profile ([INDUSTRIES.md](INDUSTRIES.md)):

```bash
ghk industry show banking          # standards, vocabulary, rules and agent guidance
ghk industry apply banking         # sets industry.id, writes .ghe/industry-context.*
ghk lint --all
```

On an existing specification set, expect the new rules to fire. Fix the errors first: they mark features that cannot be built safely as written, such as two BIAN Service Domains in one feature (GHK102) or PHI access without consent (GHK402). Disable a rule only with a reason and a date to remove the exception:

```json
{ "industry": { "id": "banking", "disabledRules": ["GHK104"] } }
```

The profile also adds human-approval paths to the agent firewall (for banking: `**/payments/**`, `**/ledger/**`, `**/*settlement*`).

## 6. Bring in the agents, inside a perimeter

```bash
ghk mcp install                               # version-pinned, read-only MCP server for Cursor, Claude Desktop and others
ghk skill                                     # rules file for Cursor, Windsurf or GitHub Copilot
ghk implement -f features/invoicing.feature   # prompt and context package for one feature
ghk firewall policy -f features/invoicing.feature
```

- **MCP is read-only by default.** Write tools need `mcp.allowWrite`, destructive tools also `GHK_ALLOW_DESTRUCTIVE=true`; an organization can lock both ([MCP_GUIDE.md](MCP_GUIDE.md)).
- **The firewall governs the agent's own actions.** In Claude Code, register `ghk firewall hook` as a `PreToolUse` hook, so edits and shell commands outside the feature's scope or on approval paths are stopped ([ENTERPRISE.md §14](ENTERPRISE.md#14-agent-firewall)).
- **Keep the LLM repair loops for review.** `ghk verify --auto-fix` and `ghk autopilot` are experimental. They write `.patch` proposals by default, and `--apply` is refused in CI and on protected branches.
- **Measure before you scale.** `ghk bench` compares your agent on your own tasks with and without the specifications ([ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)).

## 7. Generate code next to the existing code (levels 2 and 3)

### Level 2: contracts and prompts in an existing module

```bash
ghk add -f features/invoicing.feature -t src/invoicing
```

`ghk add` writes the feature's OpenAPI and AsyncAPI documents, an ADR, the agent prompts (`prompts/`) and a language-native contract when the stack has one. TypeScript and JavaScript projects also get a TypeScript contract and `__tests__/<feature>.stub.spec.ts` with one `it.todo` per step, reported as pending, never as passing. `--target` is required outside NestJS. Like `generate`, `add` keeps a file you edited and writes the new version next to it as `<file>.ghk-new`, and `ghk upgrade` never deletes what `add` wrote.

### Level 3: a generated service

```bash
ghk generate -f features/invoicing.feature --dry-run   # what would be created, updated or kept
ghk generate -f features/invoicing.feature
```

- **Implemented code is never overwritten.** A file whose checksum no longer matches what gherkin-ai wrote gets the new version next to it as `<file>.ghk-new`. `ghk generate --review` shows each diff and takes the generated version or keeps yours.
- **Mark an implemented service with a `.ghk-implemented` file at its root.** Then:
  - every file that cannot be proven unedited gets a `.ghk-new`;
  - only the runtime kernel and the contracts are **created**. Controllers, step definitions, DTOs, the kernel wiring (`RuntimeConfiguration` and its equivalents, which would add a second DataSource and outbox relay) and `application.properties` are reported as `skipped`. `--include-scaffold` creates them anyway;
  - while one kernel file is kept, the rest of the generated source is held as `.ghk-new` too, so the service still compiles. `generate` and `upgrade` report "kernel pending merge": merge the kernel `.ghk-new` files, then generate again.
- **Protect or exclude more if you need to.** `generation.protect` globs keep files (new versions go to `.ghk-new`); `generation.exclude` globs are never written at all, not even as `.ghk-new`.

  ```json
  { "generation": { "protect": ["src/main/java/**/domain/**"], "exclude": ["src/test/**/bdd/**", "seed.sql"] } }
  ```

- **Commit `.ghe/inventory.json`.** It holds the checksums that prove a generated file is unedited, and the feature and contract checksums `ghk converge` uses to detect a feature changed on its own. Since 3.2.1 the `.gitignore` gherkin-ai writes ignores the rest of `.ghe/` but keeps the inventory (`.ghe/*`, `!.ghe/inventory.json`), and an existing `.ghe/` entry is migrated. Without an inventory (a clone of an older project), a generated header is no longer enough to overwrite a file: it gets a `.ghk-new` unless `--force`.
- **The runtime kernel needs its own database objects.** On start it creates `ghk_aggregates`, `ghk_outbox`, `ghk_idempotency`, `ghk_inbox` and `ghk_sagas` in the `public` schema (since 3.2.1; before, only the integration tests created them). Give the generated service its own database (or at least its own database user) instead of sharing the legacy application's schema. If your migration tool owns the schema (Flyway, Liquibase, a migration job), add those tables there and set `GHK_MIGRATE=false`. In an implemented service the startup wiring is not generated: call the kernel's `migrate` from your own startup, or keep the tables in your migrations.
- **Coexistence with the legacy system.** The service publishes its events through the outbox to `<service>.events` (RabbitMQ, Pub/Sub, Service Bus or Kafka). Let the legacy system consume those events, or call the HTTP API `POST /api/v1/<feature>/{id}/{command}` with a JWT that carries the tenant. Move traffic one command at a time.
- **Several features per service.** Each `ghk generate -f <feature>` adds to the same service; the root contracts, routes and runtime registry cover every generated feature.

### Verify against real infrastructure

```bash
ghk verify                  # the project's tests
ghk verify --docker         # in the stack's toolchain image: no network, read-only root, dependency caches
ghk verify --services       # also the runtime integration suite (IT1–IT7) against PostgreSQL 17 and the broker
ghk converge --threshold 80
```

- **Tests, then convergence.** `verify` reports the specification convergence once the tests pass. It fails on it only with `--converge-threshold <score>` (exit 7, like `ghk converge --threshold`), so a service whose tests pass is not reported as failing because its specification is still incomplete.
- **The broker of `stack.messaging`.** `--services` starts PostgreSQL, RabbitMQ and, when the service uses one, the Pub/Sub emulator, the Service Bus emulator (with its Azure SQL Edge database) or a single-node Kafka. These are the same containers as the gherkin-ai golden builds.
- **Where it runs.** The stack's build and test commands run in `outputDir`, where the generated project lives; your own `-c` or `testCommand` runs where you call `verify`.
- **Dependency caches.** Each toolchain's caches (npm, Maven, Gradle, Go, NuGet, pip, Bundler, Mix, Cargo, Composer) are named Docker volumes `ghk-cache-<name>`, shared between runs.
- **Two container profiles.** `--docker` keeps the strict sandbox: no capabilities, a read-only root and no network by default, for test runs of code an agent may have changed. `--services` installs the stack's dependencies like the golden builds, so it uses the image's own disposable root, with the same resource limits and `no-new-privileges`. Python, Ruby and PHP projects install packages into system directories: build them with `--services`, or give `--docker` a prebuilt image (`sandbox.image`).
- **Your own services.** `sandbox.services` adds containers (a mail catcher, S3-compatible storage), with `command`, `ready`, `readyLog` and `files` when the image needs them.

## 8. Roles

| Role | Owns | Commands |
|---|---|---|
| Product owner, business analyst | The `.feature` files: scenarios, vocabulary, failure paths | `create`, `lint`, `speckit import` |
| Developers | Tags that name the model, implementation of pending steps, `.ghk-new` reviews | `lint --explain-ir`, `generate`, `implement`, `verify`, `graph` |
| QA | Scenario coverage, negative paths, the integration suite | `converge`, `verify --services`, `graph --trace` |
| Platform team | Pinned version, organization layer, CI gates, deployment targets | `config`, `report`, `upgrade --check`, `deploy` |
| Security and compliance | Industry profile, firewall approval paths, audit trail | `industry`, `firewall`, `audit export` |

## 9. Rollout checklist

**Pilot (one service, two to four weeks):**

- [ ] Exact version pinned in the repository, CI and MCP clients.
- [ ] Configuration created with `ghk detect` and reviewed; `outputDir` is a dedicated directory.
- [ ] The features of one bounded context written and linted; model names fixed with tags.
- [ ] `ghk report` running on pull requests in report-only mode.
- [ ] Industry profile chosen (or `generic`), its errors fixed.
- [ ] MCP server and firewall hook installed for the agents the team uses.

**Team:**

- [ ] Lint threshold at the agreed score, risk gate at `CRITICAL`.
- [ ] Existing code linked with `ghk:implements` / `ghk:trace` markers where `ghk graph` shows gaps.
- [ ] New services generated at level 3, verified with `--services`, deployed from the generated image.
- [ ] Regeneration owned by one job or person; `.ghk-new` files resolved before merge.

**Organization:**

- [ ] Organization configuration layer with locked provider, network and MCP settings.
- [ ] Risk weights calibrated from history (`ghk risk --calibrate --write`), risk gate at `HIGH`.
- [ ] Audit trail exported to the SIEM (`ghk audit export --format jsonl --since 1d`).
- [ ] An upgrade owner per release: `ghk upgrade` on a branch, reviewed like any change ([MIGRATION-3.2.md](MIGRATION-3.2.md)).

## What to expect, and what not

- The generated service is a verified starting point: it builds, its tests pass and its runtime passes the integration contract. The business logic in the BDD steps is left pending for your team.
- Lint, risk and the graph are deterministic; nothing in the gates calls an LLM. Risk scores are heuristics with documented weights: calibrate them before you block on them.
- Stacks outside the supported matrix (`ghk stacks`) get contracts and prompts only.
