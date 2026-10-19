# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.2.0] - Unreleased

### Added
- **Deployment targets (`deploy` in the configuration): Terraform for AWS, Google Cloud and Azure, and a Helm chart.** See `docs/DEPLOYMENT.md`.
  - **`deploy.cloud`.**
    - `aws`: ECS Fargate behind an ALB, RDS PostgreSQL, Amazon MQ for RabbitMQ, Secrets Manager and CloudWatch Logs.
    - `gcp`: Cloud Run with Direct VPC egress, Cloud SQL PostgreSQL on a private IP, Pub/Sub, Secret Manager.
    - `azure`: Container Apps, PostgreSQL Flexible Server, Service Bus with Entra ID (or an external RabbitMQ), Key Vault and Log Analytics.
  - **Network as input.** The service runs in your existing VPC or virtual network.
  - **Per environment.** One `.tfvars`, one remote-state backend file and one Helm values file per environment. In `prod`, deletion protection, high availability and longer backups are turned on.
  - **Secrets.** Terraform generates them and stores them in the cloud's secret manager: the database and broker URLs, `JWT_SECRET`, and the framework secrets.
  - **Least privilege.** The service identity can only publish to and consume from its own Pub/Sub topics and subscriptions or its Service Bus entities.
  - **`deploy.compute: kubernetes | both`.** A Helm chart for EKS, GKE or AKS:
    - probes and a restricted security context;
    - HPA, PodDisruptionBudget and an optional Ingress;
    - a ServiceAccount with the workload-identity annotation;
    - secrets from an existing Secret (External Secrets or the CSI driver).
  - **Separate relay.** Django, Laravel and Rails get their outbox relay as a separate process on each platform.
  - **Goldens.** `terraform-aws`, `terraform-gcp`, `terraform-azure` and `terraform-azure-rabbitmq` run `terraform validate` and `fmt -check`; `helm` runs `helm lint --strict` and `helm template` for every environment. Nothing is applied.
- **CI/CD pipelines (`ci.provider`: `github`, `gitlab`, `azure-devops`).** Opt-in; GitHub Actions is the default when `deploy` is set.
  - **Every provider.** Specification gates (gherkin-ai pinned), build and tests in the stack's toolchain image, the runtime integration suite against PostgreSQL and RabbitMQ, the production image, a Trivy scan and a CycloneDX SBOM.
  - **GitHub Actions also deploys.** One environment after another, with protection rules, OIDC to AWS, GCP or Azure, image push, Terraform or Helm, and a readiness smoke test.
  - **Verification.** `actionlint` and the official GitLab and Azure Pipelines schemas, in goldens.
- **Deployment readiness for AI agents.**
  - **Context files.** `.ghe/deployment-context.md` and `.json` hold the runtime contract, the target, the rules and a checklist. A Deployment Readiness section goes into the `implement` prompt and the agent prompts.
  - **Validation.** `ghk validate` checks the Dockerfile (non-root user, no secrets), `.env.example`, and hardcoded secrets in `deploy/`.
  - **Firewall.** Changes to `deploy/**`, `*.tfvars`, `*.tfbackend` and Dockerfiles in subdirectories require human approval.
  - **`.env.example`.** It lists the framework secrets (`APP_KEY`, `SECRET_KEY_BASE`, `DJANGO_SECRET_KEY`).
- **`GHK_DECLARE_TOPOLOGY=false`.** It skips creating the broker topology at start-up in every backend, for least-privilege identities when infrastructure as code owns the topology.
- **`amqps://` for PHP.** The Laravel runtime connects to RabbitMQ over TLS (Amazon MQ, CloudAMQP) through php-amqplib's connection factory. The other runtimes already took TLS from the URL.
- **Broker adapters for the Go, Rust, Ruby, Elixir and PHP runtime kernels.**
  - **Pub/Sub in all five.** REST with no client library (Go `net/http`, Rust `reqwest`, Ruby `Net::HTTP`, Elixir `:httpc`, PHP `ext-curl`), behind the same ports and run-time selection as the other stacks.
  - **Service Bus in Go only.** `runtime/servicebus_broker.go` uses `azservicebus` and `azidentity`, and is generated only with `stack.messaging: "servicebus"`.
  - **No Service Bus for Rust, Ruby, Elixir and PHP.** They have no official SDK. On Azure, use self-managed RabbitMQ or CloudAMQP (`AMQP_URL`). With `stack.messaging: "servicebus"`, RabbitMQ stays the default broker.
  - **Inbox.** The consumers poll the subscription and dead-letter through the adapter. IT1–IT7 run through the ports.
  - **Goldens.** `go-pubsub`, `go-servicebus`, `rust-pubsub`, `rails-pubsub`, `phoenix-pubsub` and `laravel-pubsub`.
- **Pub/Sub and Service Bus adapters for the .NET and Python runtime kernels.**
  - **.NET.** `Runtime/Brokers.cs` and `Runtime/ServiceBusBroker.cs`, with Azure.Messaging.ServiceBus and Azure.Identity.
  - **Python.** `app/runtime/broker.py` and `servicebus_broker.py`, with azure-servicebus and azure-identity.
  - **Service Bus is opt-in.** It is generated only with `stack.messaging: "servicebus"`.
  - **Goldens.** `dotnet-pubsub`, `dotnet-servicebus`, `fastapi-pubsub` and `fastapi-servicebus`.
- **Pub/Sub and Service Bus adapters for the TypeScript runtime kernel (NestJS, Express; goldens `nestjs-pubsub` and `nestjs-servicebus`).**
  - **Same contract as the JVM.** `runtime/broker.ts` has the ports, RabbitMQ and Pub/Sub (REST over `fetch`), and run-time selection.
  - **Service Bus.** `runtime/servicebus-broker.ts` uses `@azure/service-bus` and `@azure/identity`, and is generated only with `stack.messaging: "servicebus"`.
  - **Inbox.** The consumer now polls the subscription (`start()` / `drain()`), so it works the same on every broker.
- **Azure Service Bus adapter for the JVM runtime kernel (opt-in with `stack.messaging: "servicebus"`, golden `quarkus-servicebus`).**
  - **SDK.** It uses the official Azure SDK (`azure-sdk-bom`), with the JDK HTTP transport instead of Netty.
  - **Auth.** Microsoft Entra ID through `SERVICEBUS_NAMESPACE` (managed identity), or a connection string.
  - **Verification.** IT1–IT7 pass against the official emulator (SQL Edge plus fixed entities). The service harness can now mount files, wait on a log line and start services in order.
  - **AWS.** It is covered by Amazon MQ for RabbitMQ with the existing adapter.
- **Broker adapters in the JVM runtime kernel (Spring Java and Kotlin, Quarkus): RabbitMQ and Google Cloud Pub/Sub (golden `quarkus-pubsub`).**
  - **Ports.** The outbox relay and the inbox consumer use broker-neutral ports (`EventPublisher`, `EventSubscription`, `Broker`).
  - **Selection at run time.** `GHK_BROKER` picks the broker; otherwise the configured variables decide. `stack.messaging: "pubsub"` sets the default. One image can run on any cloud.
  - **Pub/Sub adapter.** It uses the REST API with no client library: it authenticates through the metadata server (workload identity) or `GOOGLE_OAUTH_ACCESS_TOKEN`, publish waits for Pub/Sub to accept the message, and the consumer dead-letters failed messages to the DLX topic.
  - **Tests.** IT1–IT7 now go through the adapters and pass against both RabbitMQ and the Pub/Sub emulator.
  - **Harness.** Extra services (`src/core/services.ts`) accept a start command and a readiness probe.
- **Production container image for every backend.** `ghk generate` writes a `Dockerfile` and `.dockerignore`.
  - **Image.** The build is multi-stage and the image runs as a non-root user. It is configured only with environment variables, so one image runs on ECS, Cloud Run, Container Apps and Kubernetes.
  - **Health.** NestJS and Spring (Java and Kotlin) get `/health` and `/health/ready`, which checks PostgreSQL. Each stack's probe paths are in `resolveHealth`.
  - **Verification.** Golden builds now build each image, start it next to PostgreSQL and RabbitMQ, and require both probes to answer 200; `--no-image` skips this.
  - **Docs.** See `docs/DEPLOYMENT.md`.
- **Java + Quarkus 3.40 LTS backend (golden `quarkus`).** Select it with `stack.framework: "quarkus"`.
  - **Shared kernel.** It uses the same domain kernel, Cucumber runner and runtime kernel (PostgreSQL + RabbitMQ + OpenTelemetry, IT1–IT7) as Spring.
  - **Application layer.** It has the same HTTP contract as Spring: a Quarkus REST resource and the HS256 JWT tenant filter (tenant only from the claim). The Agroal pool is configured from `DATABASE_URL` through a config source. The outbox relay runs on the Quarkus scheduler, and SmallRye Health serves `/q/health/live|ready`.
  - **Build and tests.** Maven on Java 21, with Dev Services off. A `@QuarkusTest` HTTP integration test runs under `-Pintegration`.
  - **Versions.** They are pinned in `generators/versions.ts`. The OpenTelemetry BOMs (stable and alpha) are imported before the Quarkus BOM.
- **Industry profiles (`industry.id`).** There are 8 reference-standard profiles plus `generic`: banking (BIAN, ISO 20022), telecom (TM Forum ODA, SID), manufacturing (RAMI 4.0, AAS, ISA-95), health (HL7 FHIR, openEHR), supply chain (SCOR-DS, GS1), insurance (ACORD), aviation (IATA NDC, ONE Order) and automotive (AUTOSAR, ISO 26262). See `docs/INDUSTRIES.md`.
  - **Lint.** `ghk lint`, `converge` and the MCP `lint_specification` tool run the profile rules (GHK101–GHK803) plus GHK090, which limits capability depth to L4. `industry.disabledRules` skips rules.
  - **Agents.** The IR gets `must` compliance constraints. The `ghk implement` prompt (compact with `-C`) and the agent prompts get an Industry Standards section. `.ghe/industry-context.md` and `.json` are written, with their schema in `schemas/industry-context.schema.json`.
  - **Contracts.** OpenAPI and AsyncAPI carry `info.x-industry`, and the ADR gets an Industry Standards section.
  - **Firewall.** The industry's sensitive paths (PHI, payments, OTA, …) require human approval.
  - **CLI.** New `ghk industry list|show|apply`, `ghk init --industry` (also asked interactively, and it preselects the recommended architecture), and the MCP tool `get_industry_profile`.
  - **Opt-in only.** A legacy `domainProfile` such as `payments` does not turn on an industry; `ghk upgrade` suggests `ghk industry apply banking`.

### Changed
- **Spring Boot 4.1 (Java and Kotlin).** Spring Boot 3.x lost open-source support on 2026-06-30.
  - **Versions.** Generated Spring projects use Spring Boot 4.1.1 (Spring Framework 7, Jakarta EE 11, JUnit 6), the `spring-boot-starter-webmvc` starter, Kotlin 2.3.21 and Gradle 8.14.
  - **Jackson.** The runtime kernel, shared with Quarkus, keeps Jackson 2 (`jackson-databind` and `jackson-datatype-jsr310`, now declared explicitly). Spring itself uses Jackson 3.
  - **HTTP test.** It reads `local.server.port`, because `@LocalServerPort` moved.
  - **Existing services.** Code you added on Spring Boot 3 may need the Spring Boot 4 migration steps: starters, test autoconfiguration packages, and Jackson 3.
- **Promoted to stable.** No stack and no command is in beta any more.
  - **Stacks.** Java + Quarkus and every Pub/Sub and Service Bus broker adapter. Each is built, tested and run against the official emulators by its golden build on every CI run.
  - **Commands.** `risk`, `quality`, `graph`, `speckit`, `bench` and `web`. Their exit codes and `--json` output are covered by the CLI contract tests and kept across 3.x.
  - **`ghk quality --json`.** New. It reports `gatePassed`, the `reasons` a human must approve, the risk card and the coverage result, and exits 4 when the gate fails. Before, `--json` gave only `{"ok": false}`.

### Fixed
- **Java/Kotlin frameworks without a preset** (`ktor` offered by `ghk init`, `micronaut`, ...) no longer generate Spring Boot code silently. They are reported as experimental and get contracts and prompts only. `stack-detector` recognises Quarkus, Micronaut and Ktor builds.
- **The following were found by regenerating and probing the reference projects (`ghk-test-projects`) with 3.2.0.**
  - **OpenAPI matches the generated API.** `openapi.json` describes the route every generated backend serves, `POST /api/v1/<feature>/{id}/{command}`:
    - `command` is an enum of the feature's commands;
    - the `Idempotency-Key` and `traceparent` headers are documented;
    - the body is the command payload;
    - the responses are 202, 200, 401, 409 and 422, with `CommandResult` and `Error` schemas.

    Before, it listed verb-style paths that the service never served (`POST /api/v1/<feature>`, `PUT …/{id}`, …), wrapped the body in `requestId`, `timestamp` and `payload`, and copied HTTP codes from the scenarios. `<feature>` is the `@aggregate` tag or the feature name without accents. Spanish features used to get paths such as `/api/v1/ejecuci-n-de-pagos-...-`.
  - **`ghk validate` and features without events.** It no longer fails (exit 4) on the AsyncAPI document that `generate` writes for a feature with no events. An empty `channels` object is valid AsyncAPI 2.x, so it is now a warning.
  - **Broker configuration.** With `stack.messaging: "pubsub"`, `docker-compose.yml` runs the Pub/Sub emulator and passes its variables to the app. Before, it started RabbitMQ under the name `pubsub`. `.env.example` and the Dockerfile header list the selected broker's variables.
  - **Enterprise constitution.** `ghk init --enterprise` fills `.gherkin-ai/constitution.yaml` from the answers: architecture, stack, broker, JWT auth, and the industry's compliance frameworks. It used to write a fixed NestJS/AWS template. The `.gitignore` now keeps the constitution in version control and ignores the rest of `.gherkin-ai/` (credentials and logs).
  - **PHP topology names.** The Laravel runtime named its exchange and queues after the feature, not the service, unlike every other runtime. In a multi-feature service its topology therefore differed from the other stacks and from the generated infrastructure.
  - **`ghk init` gate workflow.** It used `actions/checkout@v4` and Node.js 20, which reached end of life in April 2026. It now uses the current actions and Node.js 24.
  - **QA agent prompt.** Existing step definitions are listed by their project-relative path. Before, regenerating wrote the machine's absolute paths (such as `/home/<user>/...`) into the committed `prompts/qa-agent.md`.

## [3.1.1] - 2026-10-13

### Fixed
- **Windows (git `core.autocrlf`):** generated files checked out with CRLF line endings no longer count as edited. Before, `ghk generate` wrote `.ghk-new` instead of updating them, and `ghk upgrade` kept stale files instead of removing them. Checksums are now compared ignoring line endings.
- **Phoenix LiveView with several features:** each feature has its own LiveView route, `/<feature>`, and the first feature is also served at `/`. Before, the last generated feature replaced the others at `/`.

## [3.1.0] - 2026-10-13

Generated backends become services you can keep, from the 3.0.0 field reviews. The generated output changes: see `docs/MIGRATION-3.1.md`.

### Added
- **Application layer wired to the runtime kernel (all 12 backends).**
  - **Contract.** `POST /api/v1/<feature>/{id}/{command}` runs the command through the kernel's `CommandService`: idempotency key, outbox, `traceparent`. It returns 202 created, 200 replayed, 409 in progress, or 422 for a domain error.
  - **Tenant.** It comes only from a validated HS256 bearer token (`JWT_SECRET`; claim from the new `security.tenantClaim`, default `tenant_id`). `X-Tenant-Id` is never trusted and there is no default tenant: requests without one get 401.
  - **Outbox relay worker.** It runs in-process for NestJS, Express, Spring, ASP.NET Core, FastAPI, Go, Phoenix and Axum, and as `manage.py outbox_relay`, `artisan outbox:relay` and `rails outbox:relay` elsewhere.
  - **Spring.** It gets `application.properties` and a `DataSource` built from `DATABASE_URL`.
  - **Tests.** Each backend has unit tests of the contract with a fake command port, and an HTTP integration test against PostgreSQL.
- **Multi-feature services.**
  - **Contracts.** Each feature owns `contracts/<feature>/` (`openapi.json`, `asyncapi.json`, ADR). The root `openapi.json` and `asyncapi.json` are the union of every feature's contracts.
  - **Kernel registry.** The runtime command service handles every generated aggregate, with a new `aggregateType` request field.
  - **Service-wide files.** Routes, the NestJS `AppModule`, .NET `Program.cs`, the Python domain package, the Rust domain module, the Prisma schema (one model per feature), the Behat contexts and the frontend entry cover every generated feature.
  - **Frontends.** The entry mounts every feature's panel:
    - Vue: `main.ts`.
    - React: `main.tsx`, with a store that registers every slice and takes one client per feature (`createAppStore({ <feature>: client })`).
    - Angular: a new `AppComponent`. Each feature gets its own `<feature>-client.token.ts` (replacing `client.token.ts`), and the realtime service routes pushed events by `aggregateType`.
    - Next.js: `app/page.tsx`.
    - React Native: `App.tsx`.
    - Flutter: `main.dart`, with one tab per feature.
  - **Topology.** The RabbitMQ topology is named after the service (`<service>.events`).
  - **Golden builds** generate and test a two-feature service for every backend and frontend.
- **Protection of implemented code.** `generate` overwrites a file only if its checksum still matches what was generated; otherwise it writes `<file>.ghk-new`.
  - **New options:** `generation.protect` globs, the `.ghk-implemented` marker, `--force` and `--dry-run`.
  - **Files without a recorded checksum** are overwritten only if they carry the generated header.
- **`ghk upgrade --kernel`** refreshes only the runtime kernel: it replaces unedited files and writes `.ghk-new` for edited ones. `--all` covers every project under the current directory; `--dry-run` only reports.
- **`ghk verify --services`** runs the stack's integration suite in its toolchain container against PostgreSQL 17 and RabbitMQ 4. `sandbox.services` adds extra containers. The golden builds use the same module.
- **`ghk lint --all` / `ghk converge --all`** check every feature of every project in a monorepo and print one table (exit 4 / 7).
- **Traceability.** `ghk graph` also follows `@trace:<Symbol>` scenario tags and `ghk:implements <Symbol>` comments; scenarios carry their source line.
- **`generation.package` / `generation.groupId`** set the JVM package and groupId and the .NET root namespace.
- **Lint rule GHK015** warns about command or aggregate names with digits, example data, or more than four words.
- **`ghk implement`** lists the feature's commands, events, endpoints and scenarios, and writes one master prompt per feature.

### Changed
- **Names come from the domain, not from example data.**
  - **Command subjects** ignore quoted values, numbers and tables.
  - **Fields** come from data-table headers, never from values or from verbs and prepositions before a quoted value.
  - **Prisma** gets one model per aggregate.
- `lint` and `converge` without `-f` honour the configured `specDir`.
- Removed the disconnected 3.0 placeholders, and the now-unused `@nestjs/cqrs`, `@nestjs/schedule`, MediatR, MassTransit and EF packages:
  - **NestJS:** CQRS, outbox, saga and idempotency modules, plus the `X-Tenant-Id` middleware.
  - **Java:** CQRS, outbox, saga, idempotency and multitenancy classes.
  - **.NET:** MediatR handlers, the MassTransit saga, the EF outbox and inbox, the EF Core OpenTelemetry instrumentation, `HttpHeaderTenantService` and the Testcontainers mock. The kernel persists with Npgsql; `stack.orm: entity-framework-core` now only guides your own code (docs/ENTERPRISE.md).
  - **Django:** the ORM outbox.
  - **Go and Python:** the pattern packages.
  - **Every backend:** the in-memory HTTP handlers.
  - **Cleanup:** `ghk upgrade --prune` removes these files from existing projects when they are unedited.

### Fixed
- `lint` GHK002 now accepts a user-story actor line without an article, such as "Como cliente de la tienda".
- The Spring OpenTelemetry bean no longer fails when a global OpenTelemetry is already registered (Java agent or tests).
- Shared domain types no longer collide when a service has several features: Kotlin, C# and Python `DomainValidationException`, Go domain package, Rust domain module.

### Security
- Generated projects pin OpenTelemetry releases without known advisories:
  - **.NET:** 1.9.0 → 1.19.x. Fixes GHSA-4625-4j76-fww9 in the OTLP exporter and GHSA-g94r-2vxg-569j in `OpenTelemetry.Api`.
  - **Go:** `otel` v1.31.0 → v1.47.0. Fixes CVE-2026-24051, CVE-2026-39883, CVE-2026-81869 and CVE-2026-81870. The generated `go.mod` and the Go toolchain image now require Go 1.26.
  - **Java / Kotlin:** BOM 1.43.0 → 1.67.0. Fixes CVE-2026-45292. `Telemetry.java` no longer overrides the deprecated `TextMapGetter.keys`.
  - **Rust:** 0.31 → 0.33. Fixes CVE-2026-48504.
  - **Node:** the floor of `@opentelemetry/core` and `sdk-trace-base` is now `^2.12.0`. Fixes CVE-2026-54285.

## [3.0.1] - 2026-10-09

Bug-fix release from the 3.0.0 field reviews (an LMS of 7 services and a 9-feature NestJS/Vue project). No change to the generated output contract; `ghk upgrade` is not required.

### Fixed
- **`implement` crash and lost checksums.** `generate` and the audit trail wrote two different formats to `.ghe/inventory.json`. The file is now `{version: '2', artifacts, executions}`:
  - both old formats are still read;
  - `generate` merges artifacts across features instead of replacing them;
  - the audit trail only touches executions, so `upgrade --prune` keeps working after `implement`.
- **`converge` as a gate.** Scores now track real evidence:
  - **Coverage:** JaCoCo totals come from the report-level counters (not the first method). `lcov.info` is read, and Cobertura attributes are read in any order. An unrecognised report no longer stops the search. With no report the dimension shows `n/a` and is left out of the average instead of counting as 0. `coverageTarget` is read from the project config.
  - **Architecture:** layers are found at any depth: Maven/Gradle packages, `internal/`, `.NET` `X.Domain` projects and common aliases such as `adapters` and `api`.
  - **Specification Quality:** uses the lint score, so it no longer repeats Scenario Completeness.
  - **Traceability:** events asserted in `Then` steps count as tested.
- **Scenario categories:**
  - a scenario carries every category that applies, for example authorization and error-handling;
  - authorization also recognises roles, permissions, 401/403 and access denied;
  - a logged-in success still counts as the happy path.
- **`ghk quality`:** JaCoCo CSV totals are summed over every line, and the Go coverage total is parsed.
- **`lint`:**
  - GHK006 and GHK007 ignore quoted example values such as `"MATH-101"`;
  - acronyms mentioned in the feature description count as defined;
  - GHK006 reports each term once per feature;
  - a missing or unparseable file fails the run (exit 4, also with `--json`);
  - the average only counts files that were linted.
- **`validate`:**
  - prohibited framework imports are checked only in domain/application code, not in infrastructure, controllers, Nest modules or `main.ts`;
  - `node_modules`, `dist`, `target` and `.git` are skipped;
  - AsyncAPI auto-detection prefers the feature's own document;
  - `--target` is registered.
- **`verify`:** an unset container limit keeps its default instead of producing `--network undefined`.
- **Locale:**
  - the project's `locale` (and `GHK_LOCALE`) takes precedence over the global choice;
  - validator messages and the `add` prompt are translated instead of mixing Spanish and English.
- **Local environment:**
  - `.env.example` and `docker-compose.yml` use each stack's own variables and port (Spring, .NET, Python, Go, Rails, Phoenix, …);
  - both always provide `DATABASE_URL` and `AMQP_URL` for the runtime kernel;
  - RabbitMQ gets a dev user, because `guest` is localhost-only;
  - the Serverless runtime is `nodejs22.x`.
- **Gherkin:** scenarios inside `Rule:` blocks are parsed (with the Rule's tags), and `Background` steps get step definitions and run first in every generated scenario.

## [3.0.0] - 2026-10-05

Enterprise-readiness release, driven by the reviews of 2.6.x. Contains breaking changes: see `docs/MIGRATION-3.0.md`. For operators: `docs/ENTERPRISE.md`. Support and versioning policy: `SUPPORT.md`.

### Added
- **Runtime kernel for every backend:**
  - **What it is.** A verified path for persistence, messaging and tracing (`docs/RUNTIME-KERNEL.md`):
    - a PostgreSQL command service with idempotency claims and a transactional outbox;
    - an outbox relay with `FOR UPDATE SKIP LOCKED` leases and publisher confirms;
    - an inbox consumer with deduplication and a dead-letter queue;
    - a saga orchestrator with reverse compensation;
    - W3C trace context across the command, publish and consume spans.
  - **Where.** Implemented with each language's standard driver, AMQP client and OpenTelemetry SDK: NestJS, Express, ASP.NET Core, Spring Boot (Java, Kotlin), FastAPI, Django, Go, Laravel, Rails, Phoenix and Axum.
  - **Verification.** The integration suite (IT1–IT7) runs in every backend golden build against PostgreSQL 17 and RabbitMQ 4.
- **OpenTelemetry in the frontends:** the generated API clients (React, Vue, Angular, Next.js, React Native, Flutter) send a `traceparent` header, and their generated tests assert it.
- **Agent firewall:**
  - **What it decides.** One decision point for agent writes, commands, network access, secrets and MCP tools: ALLOW, REQUIRE_APPROVAL or DENY.
  - **Policy sources.** Built-in rules, `policy.firewall`, `.ghkgovernance.yaml` and the impact scope of the feature being implemented.
  - **Where it applies.** The MCP server, `verify --auto-fix --apply` and `autopilot --apply` (blocked files become proposals), and `ghk firewall check|policy|hook`, including a Claude Code `PreToolUse` hook.
  - **Self-protection.** Agents cannot edit `.ghkgovernance.yaml`.
- **Delivery risk (`ghk risk`):**
  - **Input.** The git change set, an explicit file list or the working tree.
  - **Scoring.** LOW to CRITICAL across six weighted dimensions, each with evidence: security, business criticality, change radius, test weakness, contract drift and architecture drift.
  - **Policy and CI.** `policy.risk.requireApprovalAt` and `policy.risk.criticalPaths` configure approval; `--fail-on` gates CI with exit code 4.
- **Traceability graph (`ghk graph`):**
  - **What it links.** Feature → scenario → command / event / endpoint, connected to the files and tests that reference them.
  - **Output.** A summary, JSON, Mermaid or DOT; `--trace` for one symbol and `--scope` for a feature's change scope.
- **GitHub Spec Kit interop:** `ghk speckit import` (spec.md → .feature) and `ghk speckit export`, round-tripping user stories, priorities and FR-### requirements.
- **A/B benchmark harness (`ghk bench`):**
  - **What it compares.** The same agent on the same task, with and without gherkin-ai.
  - **Scoring.** Deterministic: build, tests, hidden acceptance tests (copied in after the agent finishes), convergence, files changed and time.
  - **Cost.** No LLM is called by the harness itself.
- **Hardened Docker sandbox for `verify --docker`:**
  - no network by default (`--docker-network`);
  - memory, CPU and process limits;
  - all capabilities dropped, `no-new-privileges` and a read-only root filesystem;
  - the stack's verified toolchain image;
  - configurable in `sandbox.*`.
- **AWS CDK infrastructure is opt-in** (`infrastructure.awsCdk`, default on for SQS/SNS messaging). The generated app (EKS with IRSA, DLQ alarm) has its own golden build with CDK assertions and `cdk synth`.
- **`converge` measures generated contracts:** OpenAPI operations and status codes, AsyncAPI events, and domain types in the generated sources. Each dimension reports its basis (`artifacts`, `specification` or `reports`).
- `SUPPORT.md` (semver contract and support windows) and issue templates.
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
- **`ghk upgrade`: assisted upgrade of 2.x projects.**
  - Reports what the project needs: generated-file versions, config, CI scripts, MCP clients and legacy credential files.
  - With `--apply`, regenerates on a new git branch and removes stale generated files only when they were never edited.
  - `--check` gates CI.
- **NestJS 12 and Prisma 7 (opt-in):**
  - New config keys `stack.frameworkVersion` (`"11"` default, `"12"`) and `stack.ormVersion` (`"6"` default, `"7"`), also settable with `ghk init --frameworkVersion/--ormVersion`.
  - NestJS 12 projects are generated as ES modules.
  - Prisma 7 projects use the `prisma-client` generator, `prisma.config.ts` and the driver adapter for the configured database.
  - All four NestJS combinations and Express with Prisma 7 have their own golden build.
- **`@aggregate:Name` feature tag** sets the type name used by every generator, instead of the name derived from a long feature title.

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
- **Generated NestJS and Express projects use current dependencies:**
  - NestJS 11, Express 5, Prisma 6.19, Zod 4 (`z.uuid()`, `z.email()`, `z.iso.datetime()`), Jest 30, Cucumber 13, TypeScript 6 (`module: nodenext`), `@types/node` 22.
  - Step definitions load through `tsx` instead of the unmaintained `ts-node`.
  - Tenant scoping moved from the removed Prisma `$use` middleware to a client extension (`PrismaService.tenant`). The generated repository uses it.
  - NestJS 12 and Prisma 7 are opt-in (see Added). NestJS 11 and Prisma 6 stay the defaults.
- **TypeScript projects without a NestJS or Express backend:**
  - A frontend framework in `stack.framework` (`react`, `vue`, `angular`, `nextjs`, `react-native`) generates that stable frontend project.
  - Other backends (`fastify`, `node-native`) generate contracts and prompts only, and are reported as experimental.
  - Previously both got a Playwright spec containing only comments. `nest` is accepted as an alias of `nestjs`.

### Fixed
- **`autopilot --apply` skipped the CI and protected-branch guards.** It imported the write guard but never called it, and did not pass `--allow-unattended-writes` / `--force-branch` on to its verify step.
- **`.ghkgovernance.yaml` `allowedPaths` was never enforced.** Only protected paths were checked. The glob matcher also accepted any path containing the pattern text.
- **Documentation:** the architecture page listed MCP tools that do not exist; the README listed container images the CLI does not use; the evaluation report was a self-scored rubric. They were replaced by documents that match the code and by reproducible evidence (`docs/EVALUATION_REPORT.md`).
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
- Generators derived the feature's type names differently, so .NET handlers referenced commands and read models the contracts never declared; all generators now share one naming helper.
- Features outside `outputDir` were not found by the generated test runners; they are now copied into `<outputDir>/features/`.
- Go contracts imported `uuid` without using it when a feature declared no events (`go vet` failure).
- Prisma schemas redeclared `id`/`tenantId` when the feature mentioned an `ID` value.
- Ruby and Elixir step definitions double-escaped `/` and `|`, breaking steps that contain URL paths; Go dropped backticks from step patterns.

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
