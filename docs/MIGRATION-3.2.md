# Migrating to 3.2

3.2 makes generated backends deployable: a production image, broker adapters for Pub/Sub, Service Bus and Kafka, OTLP trace export, database TLS, Terraform, Helm and CI/CD. It also adds Quarkus, Spring Boot 4.1 and industry profiles. Nothing in `gherkin-ai.config.json` has to change, and the CLI contract (commands, flags, exit codes, `--json`) is unchanged. The generated code does change, so plan one regeneration per service.

To adopt gherkin-ai in a project it never generated, see [ADOPTION.md](ADOPTION.md) instead.

## From 3.2.0 to 3.2.1

No configuration change is required. The CLI contract (commands, exit codes, `--json` shapes) is unchanged except for the points below, which were wrong in 3.2.0 (found by adopting it in an implemented multi-service project; see the CHANGELOG):

| What | 3.2.0 | 3.2.1 | Do |
|---|---|---|---|
| `generate` / `upgrade --apply` in a project with `.ghk-implemented` | created scaffolding next to your code (32 files in one service), and a half-new kernel that did not compile | creates only the kernel and the contracts; holds generated source as `.ghk-new` while the kernel is pending merge | delete the `.ghk-rejected` style workarounds; use `generation.exclude` for anything else you never want written |
| `.gitignore` | `.ghe/` ignored | `.ghe/*` ignored, `.ghe/inventory.json` versioned (entry migrated on the next `generate`) | commit `.ghe/inventory.json` |
| No inventory, file with a generated header | overwritten | `.ghk-new` (unless `--force`; `upgrade --apply` still trusts headers on its branch) | – |
| `ghk quality` | passed when tests failed or no coverage was read; risk gated even without a change set | fails on failing tests or no coverage (`--allow-missing-coverage`); risk gates only with a change set (`--base <ref>` or uncommitted changes) | pass `--base origin/main` in CI where the risk should gate |
| `ghk converge` | score only | also fails (exit 7) on contract drift: `spec-changed`, `live-contract` (`--live`) | regenerate after editing a feature; add `--live <api-docs URL>` in an environment where the service runs |
| `ghk converge -f <file> --json` | exit 0 below the threshold | exit 7 below the threshold, like the text output | – |
| `verify --auto-fix` | ran on the host by default | runs in the sandbox container; `--host` for the host. LLM, cloud and registry credentials are never passed to it | pass `--host` where Docker is not available |
| Repair loop writes | specs could not be edited; contracts and tests could | specs, contracts and tests need a human | – |
| Proposals | `.ghe/patches/<basename>.proposed` (full file; equal basenames collided) | `.ghe/patches/<path as a__b>.patch` (unified diff) | `git apply` them |
| Agent firewall, commands | prefix match on the raw line | parsed like a shell (see ENTERPRISE.md §14); `ghk` only for read-only subcommands | add exact commands to `policy.firewall.allowCommands` if a hook now asks for approval |
| Node.js older than 22.12 | ran anyway | exits 2 with the version found | – |

## Choose your path

| You are on | Read, in this order | Then |
|---|---|---|
| 3.1.x | this guide | run the steps below |
| 3.0.x | [MIGRATION-3.1.md](MIGRATION-3.1.md) (application layer, JWT tenant, several features per service, `.ghk-new` protection), then this guide | run the steps below once, with 3.2 |
| 2.x | [MIGRATION-3.0.md](MIGRATION-3.0.md) (credentials, exit codes in CI scripts, MCP pinning), then the 3.1 guide, then this one | run the steps below once, with 3.2 |

You do not need to install each version in between. `ghk upgrade` in 3.2 checks a project against everything since 2.x and regenerates it with the current generators. The earlier guides list the manual changes it cannot make for you: CI scripts that compare exit codes with `1`, clients that sent `X-Tenant-Id`, frontends that passed `tenantId`, and credentials.

## Before you start

- [ ] **Commit or stash** everything. The upgrade runs on its own branch and refuses a dirty working tree (unless `--force`).
- [ ] **Pin 3.2.1** in the repository, CI and MCP clients (`npm install --save-dev --save-exact gherkin-ai@3.2.1`, `ghk mcp install`).
- [ ] **Node.js 22.12 or later** on developer machines and build agents.
- [ ] **Check that `.ghe/inventory.json` exists** where you regenerate. It holds the checksums that prove a file is unedited. From 3.2.1 it is versioned; in a clone of an older project it may be missing, and then generated files get a `.ghk-new` instead of being overwritten. Add a `.ghk-implemented` file at the root of every implemented service.
- [ ] **Read the report** before applying anything:

  ```bash
  ghk upgrade                                            # report only
  ghk generate -f features/<feature>.feature --dry-run   # created / updated / kept, per file
  ```

## What changes in the generated code

| Area | 3.1 | 3.2 | Action |
|---|---|---|---|
| Production image | none | `Dockerfile` (multi-stage, non-root) and `.dockerignore` for every backend; NestJS and Spring get `/health` and `/health/ready` (Quarkus: `/q/health/live` and `/q/health/ready`) | Build and run the image; point your platform's probes at those paths ([DEPLOYMENT.md](DEPLOYMENT.md)) |
| Spring Boot (Java, Kotlin) | 3.x, Gradle 8.10 | 4.1.1 (Spring Framework 7, Jakarta EE 11, JUnit 6), `spring-boot-starter-webmvc`, Kotlin 2.3.21, Gradle 8.14 | Migrate the code you added to Spring Boot 4: starters, test auto-configuration packages, Jackson 3. The runtime kernel keeps Jackson 2 |
| Runtime kernel: brokers | RabbitMQ | Broker-neutral ports (`EventPublisher`, `EventSubscription`, `Broker`); RabbitMQ, Pub/Sub, Service Bus and Kafka adapters, chosen at start-up (`GHK_BROKER`, then the variables present, then `stack.messaging`) | If you edited the kernel, merge its `.ghk-new` files (`ghk upgrade --kernel`) |
| Inbox consumer (TypeScript) | push consumer | polls its subscription: `start()` / `drain()` | Update code that started the consumer yourself |
| `openapi.json` | verb-style paths the service never served (`POST /api/v1/<feature>`, `PUT …/{id}`), body wrapped in `requestId` / `payload` | the served route `POST /api/v1/<feature>/{id}/{command}`: `command` enum, `Idempotency-Key` and `traceparent` headers, 202 / 200 / 401 / 409 / 422 | Regenerate API clients and contract tests built from the old document. Non-English features also get a new `<feature>` slug: the `@aggregate` tag, or the name without accents |
| OpenTelemetry | Spring always exported over gRPC to `localhost:4317`; Quarkus to `localhost:4318` without `service.name`; .NET never; the others did not export | every backend exports over OTLP/HTTP **only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, with `service.name` from `OTEL_SERVICE_NAME` | Set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, port 4318) wherever you collected traces before |
| Database TLS | the JVM and .NET dropped the URL's query string; Elixir and PHP ignored `sslmode`; Rust had no TLS; node-postgres treated `require` as `verify-full` | every runtime honours `sslmode` (`require`, `verify-ca`, `verify-full`) and `sslrootcert` in `DATABASE_URL` | Check every `DATABASE_URL`: a `sslmode=require` that used to be ignored now requires a TLS-enabled server. The generated Terraform sets `?sslmode=require` and `db_require_tls = true` |
| Laravel broker topology | exchange and queues named after the feature | named after the service (`<service>.events`, `.consumer`, `.dlx`, `.dlq`), like every other runtime | Drain the old queues before you deploy, or bind the new queue to the old exchange during the switch |
| Rust, several features | only the last generated feature was served; the others answered 422 | every feature is served | — |
| Java / Kotlin frameworks without a preset (`ktor`, `micronaut`, …) | Spring Boot code was generated silently | contracts and prompts only (experimental) | Set `stack.framework` to `spring-boot` or `quarkus` to keep generating a service |
| Commands of non-English features | always one generic `process_<aggregate>` | named by `@command:` / `@event:` tags in any dialect (lint rule GHK016 reports the generic ones) | Adding the tags changes the command names in the route and the contracts: see step 6 |
| Agent prompts | listed the step skeletons of the previous run (twice for Java and Kotlin) | list only step definitions written or edited by people | — |
| `ghk init --enterprise` | fixed NestJS/AWS constitution | constitution filled from the answers; `.gitignore` keeps `.gherkin-ai/constitution.yaml` in version control | — |

## What changes in the CLI

| Area | Change | Action |
|---|---|---|
| Lint | New rule **GHK016** (info) for features whose commands can only be named generically. It lowers the score of those features by one point | Re-baseline `lint --threshold` if your gate sits exactly at the old score, or add the tags (step 6) |
| Lint | Industry rules GHK090–GHK803 run only with `industry.id` | Opt in when ready (step 9) |
| Lint | GHK009 also recognizes rejected, denied, failed, expired and declined outcomes (and the Spanish forms) as error paths; GHK007 no longer reports the word "service". Some scores go up | Nothing; re-read the scores once |
| `ghk init` | refuses (exit 2) when `gherkin-ai.config.json` exists; `--force` replaces it | Scripts that re-ran `init` over a project must stop doing so, or pass `--force` |
| `.ghkgovernance.yaml` | carries a checksum; `generate` refreshes it only while it is unedited, otherwise writes `.ghkgovernance.yaml.ghk-new` | A policy written by an earlier version has no checksum, so the next `generate` keeps it and writes `.ghk-new`: compare them once and keep one |
| `ghk add` | TypeScript files only for TypeScript projects, `it.todo` tests, `.ghk-new` protection, `--target` required outside NestJS | Delete stubs an earlier `add` wrote for other stacks |
| `ghk detect` | `outputDir: ./generated-specs` (it used to point at `./src` or `./app`); also detects Elixir, nested `.csproj` and `build.gradle.kts` | Check `outputDir` in configurations created by `detect` |
| `ghk verify --services` | starts the broker of `stack.messaging`, runs in `outputDir`, mounts dependency caches; `--isolated` is an alias | — |
| `ghk verify` after passing tests | reports the convergence score; it no longer fails below a fixed 80% | Pipelines that relied on that gate: add `--converge-threshold 80` (exit 7), or run `ghk converge --threshold 80` |
| `ghk skill` | MCP entries use the pinned `npx -y gherkin-ai@<version> mcp`, like `ghk mcp install` | Re-run `ghk skill` (MCP mode) to replace entries with a local path |
| `ghk quality --json` | reports `gatePassed`, `reasons`, the risk card and coverage, and exits 4 when the gate fails; it used to print only `{"ok": false}` | Update scripts that parsed the old output |
| Tiers | every stack and command is stable (`risk`, `quality`, `graph`, `speckit`, `bench`, `web` were beta) | — |
| New commands and flags | `ghk industry`, `ghk report`, `ghk lint --explain-ir`, `ghk generate --review`, `ghk graph --serve`, `ghk risk --calibrate` | Optional ([COMMANDS.md](COMMANDS.md)) |
| New configuration keys | `industry`, `deploy`, `ci`, `policy.risk.weights`; `stack.messaging` accepts `pubsub`, `servicebus` and `kafka`; `stack.framework` accepts `quarkus` (Java and Kotlin) | All optional |

## Steps

1. **Run the upgrade on a branch.**

   ```bash
   ghk upgrade --apply --commit      # branch ghk-upgrade-v3.2.0: config fixes, every feature regenerated, unedited leftovers removed
   ```

   Items marked `[manual]` (CI files, MCP clients, credentials) are reported with a hint and never edited. For a monorepo, run it in each service directory.

2. **Resolve the `.ghk-new` files.**

   ```bash
   ghk generate --review             # diff per file: take the generated version or keep yours
   ```

   A version you keep is recorded and not offered again. In CI, `--accept-new` or `--keep-mine` decide every file at once; without them the command exits 4 while versions are pending.

3. **Refresh an edited runtime kernel.** If you changed kernel files, `ghk upgrade --kernel --dry-run` shows what changes, and `ghk upgrade --kernel` writes the new kernel next to your edits. The 3.2 controllers and relays call the broker ports, so merge before you build.

4. **Spring services: move your own code to Spring Boot 4.** The generated `pom.xml` or `build.gradle.kts` is already on 4.1.1. Follow the Spring Boot 4 migration guide for what you added: renamed starters, moved test auto-configuration packages, Jackson 3.

5. **Update the environment of every deployment:**
   - `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_SERVICE_NAME`) where traces should be exported;
   - `DATABASE_URL` with the `sslmode` your database actually supports;
   - the broker variables, if you move off RabbitMQ: `GHK_BROKER` plus `PUBSUB_PROJECT_ID`, `SERVICEBUS_NAMESPACE` or `KAFKA_BOOTSTRAP_SERVERS` ([DEPLOYMENT.md](DEPLOYMENT.md#runtime-contract));
   - `GHK_DECLARE_TOPOLOGY=false` if infrastructure as code owns the topics and queues.

6. **Name the commands of non-English features.** `ghk lint` reports GHK016 on them. Add `@command:` and `@event:` tags to the feature (`ghk lint --explain-ir` shows the result), then regenerate. The command route changes, for example from `…/{id}/process_payment_execution` to `…/{id}/execute_payment`. Treat it as an API change: update the frontends and clients, or keep the tags off until you can.

7. **Laravel services: switch the broker topology.** Stop the relay, let the consumer drain the feature-named queue, deploy, then delete the old exchange and queues.

8. **Re-baseline the gates.** Re-run `ghk lint --all` and `ghk converge --all` and adjust the thresholds in CI only if a gate sits exactly at the old score. Scripts that read `ghk quality --json` need the new fields.

9. **Opt in to what 3.2 adds, one at a time:**
   - an industry profile: `ghk industry apply <id>` ([INDUSTRIES.md](INDUSTRIES.md));
   - a deployment target: `deploy.cloud` and `deploy.compute`, then `ghk generate` ([DEPLOYMENT.md](DEPLOYMENT.md));
   - CI/CD pipelines: `ci.provider` (`github`, `gitlab`, `azure-devops`);
   - another broker: `stack.messaging` `pubsub`, `servicebus` or `kafka` (adds the SDK where one is needed).

10. **Verify against real infrastructure.**

    ```bash
    ghk verify --services             # build, tests and IT1–IT7 against PostgreSQL 17 and the service's broker
    docker build -t my-service .      # then start it and check the liveness and readiness probes
    ghk converge --all --threshold 80
    ghk validate                      # also checks the Dockerfile, .env.example and deploy/ for secrets
    ```

    `--services` starts the broker of `stack.messaging` (RabbitMQ, the Pub/Sub or Service Bus emulator, or Kafka) and runs in `outputDir` ([ADOPTION.md](ADOPTION.md#verify-against-real-infrastructure)). `--isolated` is now a deprecated alias of `--services`.

11. **Review and merge** the upgrade branch like any other change. `ghk upgrade` never pushes.

## Rolling back

The upgrade lives on its own branch: delete it to return to 3.1. Pin `gherkin-ai@3.1.x` again in CI and in the MCP clients. Services you already deployed from 3.2 keep working with a 3.1 CLI, but the next 3.1 regeneration writes the 3.1 files back.
