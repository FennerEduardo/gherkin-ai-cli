# Verification evidence — gherkin-ai 3.3.0

This document lists what is verified for each release, how it is verified, and how to reproduce it. Every result below comes from a command you can run yourself; nothing is scored by hand.

**Run of record:** 2026-11-03, gherkin-ai 3.3.0 (branch `feat/3.3.0`, `40219a5`). The CLI under test is the branch's build (`npm run build`, `dist/`). CI runs the same goldens against the packaged tarball (`npm pack`, installed in a clean directory and passed as `GHK_CLI`), the file `release.yml` publishes. The 3.2.2 and earlier reports are in the git history of this file.

**Environment:**

- Ubuntu on WSL 2 with Docker Engine 29.9.2 (Linux, as on the CI runners), Node.js 26.13;
- the official toolchain images listed below;
- databases for the runtime kernel: PostgreSQL `postgres:17-alpine`, MySQL `mysql:8.4` and MongoDB `mongo:8.0` (a single-node replica set);
- RabbitMQ `rabbitmq:4-alpine` for the integration suites;
- the official emulators or brokers of the broker variants: the Pub/Sub emulator (`google-cloud-cli:emulators`), the Service Bus emulator with Azure SQL Edge, and `apache/kafka:4.1.0` (single-node KRaft).

## 1. Golden builds: every stable stack

`scripts/golden-build.js` takes the following steps for each stack in `scripts/golden-stacks.js`:

1. generates a project with the CLI, from `scripts/golden-feature.feature` (and, for backends and frontends, a second feature in the same service);
2. builds it inside the stack's official image;
3. runs its generated unit, contract and BDD tests;
4. for backends, runs the runtime integration suite (IT1–IT7) and the HTTP integration tests against the kernel's real database (PostgreSQL unless stated) and the stack's broker;
5. for backends, builds the production image (`Dockerfile`), starts it against a **fresh database** (the service must create the runtime kernel's tables, or collections and indexes, itself, as in a first deployment) next to an OpenTelemetry collector, requires its liveness and readiness probes to answer 200, sends one command with a JWT (HTTP 202), and requires the service's spans to reach the collector over OTLP.

A stack passes only if every step exits with code 0. Pending BDD steps are allowed; failing or erroring tests are not. Deployment and CI goldens run their tools instead (sections 1.4 and 1.5).

### 1.1 Backends on PostgreSQL

| Stack | Image | Build + generated tests | IT1–IT7 + HTTP | Production image + OTLP | Time |
|---|---|---|---|---|---|
| NestJS 11 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 106 s |
| NestJS 12 + Prisma 7 (ESM) | `node:24-bookworm` | pass | pass | pass | 93 s |
| NestJS 12 + Prisma 6 (ESM) | `node:24-bookworm` | pass | pass | pass | 99 s |
| NestJS 11 + Prisma 7 (MySQL adapter) | `node:24-bookworm` | pass | pass | pass | 76 s |
| Express 5 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 301 s |
| Express 5 + Prisma 7 | `node:24-bookworm` | pass | pass | pass | 234 s |
| ASP.NET Core 8 | `mcr.microsoft.com/dotnet/sdk:8.0` | pass | pass | pass | 81 s |
| Spring Boot 4.1 (Java, Maven) | `maven:3.9-eclipse-temurin-17` | pass | pass | pass | 205 s |
| Spring Boot 4.1 (Kotlin, Gradle) | `gradle:8.14-jdk17` | pass | pass | pass | 440 s |
| Quarkus 3.40 LTS (Java, Maven) | `maven:3.9-eclipse-temurin-21` | pass | pass | pass | 285 s |
| Quarkus 3.40 LTS (Kotlin, Gradle) | `gradle:8.14-jdk21` | pass | pass | pass | 615 s |
| FastAPI | `python:3.12-slim` | pass | pass | pass | 95 s |
| Django + DRF | `python:3.12-slim` | pass | pass | pass | 99 s |
| Go (chi) | `golang:1.26` | pass | pass | pass | 99 s |
| Laravel 13 | `composer:2` (+ pdo_pgsql, sockets) | pass | pass | pass | 332 s |
| Rails 8 | `ruby:3.3` | pass | pass | pass | 155 s |
| Phoenix | `elixir:1.17` | pass | pass | pass | 134 s |
| Phoenix LiveView | `elixir:1.17` | pass | pass | pass | 144 s |
| Axum (Rust) | `rust:1.99` | pass | pass | pass | 334 s |

The generated Python projects no longer cap pytest below 9.2 (M-01): pytest-bdd 9.0.1 works with it (`pytest>=8.3`, `pytest-bdd>=9.0.1`).

### 1.1a Backends on MySQL and MongoDB

`stack.kernelDatabase` (opt-in; PostgreSQL is the default) runs the runtime kernel on MySQL 8.4 or on MongoDB 8. In 3.2.2 only the TypeScript runtimes ran on MySQL. In 3.3.0 every core runtime runs on both. [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md) lists the driver of each runtime and what changes on each database. The goldens are the same as on PostgreSQL: IT1–IT7, the HTTP tests, and a production image that creates its tables (or collections and unique indexes) in a fresh database.

| Stack | MySQL 8.4 | Time | MongoDB 8 | Time |
|---|---|---|---|---|
| NestJS 11 | pass | 262 s | pass (new) | 274 s |
| Express 5 | pass | 154 s | pass (new) | 116 s |
| Spring Boot 4.1 (Java) | pass (new) | 243 s | pass (new) | 184 s |
| Spring Boot 4.1 (Kotlin) | pass (new) | 444 s | pass (new) | 398 s |
| Quarkus 3.40 LTS (Java) | pass (new) | 293 s | pass (new) | 283 s |
| Quarkus 3.40 LTS (Kotlin) | pass (new) | 665 s | pass (new) | 616 s |
| FastAPI | pass (new) | 107 s | pass (new) | 80 s |
| Django + DRF | pass (new) | 96 s | pass (new) | 85 s |
| ASP.NET Core 8 | pass (new) | 96 s | pass (new) | 89 s |
| Go (chi) | pass (new) | 99 s | pass (new) | 129 s |

On MongoDB, IT3 (two relays, 20 events published once) relies on an atomic `findOneAndUpdate` lease per event instead of `FOR UPDATE SKIP LOCKED`. IT1, IT2, IT5 and IT6 run in multi-document transactions, which is why the kernel needs a replica set; the generated `docker-compose.yml` starts one.

Three defects were found while building these goldens and were fixed before the run of record:

- With MySQL, Spring services sent no span to the collector: Connector/J installs its own OpenTelemetry hook before Spring registers the SDK. The JDBC URL now sets `openTelemetry=DISABLED`.
- With MongoDB, Spring failed to start (`NoClassDefFoundError`): the generated pom pinned `mongodb-driver-sync` against the driver core that the Spring Boot BOM manages. The version now comes from the BOM.
- With MongoDB, Quarkus had no readiness check without the Agroal datasource. The kernel now ships its own.

### BFF role

`stack.role: "bff"` generates a backend-for-frontend without a runtime kernel. Its golden builds it, runs its tests, and checks that it has no database seed and no AsyncAPI file and that its routes are under `/bff/v1/`.

| Stack | Image | Result | Time |
|---|---|---|---|
| Express 5 | `node:24-bookworm` | pass | 26 s |
| NestJS 11 | `node:24-bookworm` | pass | 24 s |
| NestJS 12 | `node:24-bookworm` | pass | 20 s |
| Spring Boot 4.1 (Java) | `maven:3.9-eclipse-temurin-17` | pass | 17 s |

### 1.2 Broker adapters

The same backend, build and tests, with the runtime kernel on another broker. IT1–IT7 run through the broker ports.

| Broker | Stacks (golden) | Broker under test | Result |
|---|---|---|---|
| Google Cloud Pub/Sub | NestJS (113 s), Quarkus (292 s), .NET (95 s), FastAPI (82 s), Go (93 s), Rust (338 s), Rails (75 s), Phoenix (128 s), Laravel (335 s) | official emulator | 9 of 9 pass |
| Azure Service Bus | NestJS (157 s), Quarkus (346 s), .NET (160 s), FastAPI (146 s), Go (134 s) | official emulator + Azure SQL Edge | 5 of 5 pass |
| Apache Kafka | Spring Java (257 s), Quarkus (327 s), NestJS (304 s), .NET (49 s), FastAPI (88 s), Go (180 s) | `apache/kafka:4.1.0`, single node | 6 of 6 pass |

In 3.2.2 the .NET Kafka golden failed IT6 once in every three to five runs. The test's idle window started before the consumer group had been assigned partitions, and it now waits for the assignment (M-02). After the fix it passed five runs in a row, and it passes in this run.

### 1.3 Frontends and contracts

| Stack | Image | Check | Time |
|---|---|---|---|
| React 19 | `node:24-bookworm` | build and tests, including `traceparent` tests | 35 s |
| Vue 3 | `node:24-bookworm` | build and tests, including `traceparent` tests | 24 s |
| Angular 22 | `node:24-bookworm` | build and tests, including `traceparent` tests | 40 s |
| Next.js 16 | `node:24-bookworm` | build and tests, including `traceparent` tests | 34 s |
| React Native (Expo 57) | `node:24-bookworm` | build and tests, including `traceparent` tests | 58 s |
| Flutter (standalone app) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 28 s |
| Flutter (frontend) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 25 s |
| gRPC + GraphQL contracts | `node:24-bookworm` | `buf build`, `buf lint`, graphql-js validation | 59 s |
| AWS CDK (opt-in, legacy) | `node:24-bookworm` | CDK assertion tests and `cdk synth` | 26 s |

### 1.4 Deployment targets

Nothing is applied. Terraform runs `init -backend=false`, `validate` and `fmt -check`; Helm runs `lint --strict` and `template` for every environment.

| Golden | Image | Covers | Time |
|---|---|---|---|
| `terraform-aws` | `hashicorp/terraform:1.16.6` | ECS Fargate, ALB, RDS, Amazon MQ, Secrets Manager; separate relay (Rails) | 194 s |
| `terraform-gcp` | `hashicorp/terraform:1.16.6` | Cloud Run, Cloud SQL, Pub/Sub, Secret Manager; relay worker pool (Laravel) | 51 s |
| `terraform-azure` | `hashicorp/terraform:1.16.6` | Container Apps, PostgreSQL Flexible, Service Bus, Key Vault (NestJS) | 85 s |
| `terraform-azure-rabbitmq` | `hashicorp/terraform:1.16.6` | Azure with an external RabbitMQ (Phoenix) | 84 s |
| `terraform-aws-kafka`, `terraform-gcp-kafka`, `terraform-azure-kafka` | `hashicorp/terraform:1.16.6` | an existing Kafka cluster on each cloud, no native broker | 210 s, 52 s, 85 s |
| `terraform-aws-vm`, `terraform-gcp-vm`, `terraform-azure-vm` | `hashicorp/terraform:1.16.6` | `deploy.compute: "vm"`: one VM per service with cloud-init and Caddy, the same managed database, broker and secrets (Rails, Laravel, NestJS on Service Bus) | 183 s, 52 s, 86 s |
| `terraform-aws-base`, `terraform-gcp-base` (new), `terraform-azure-base` (new) | `hashicorp/terraform:1.16.6` | `deploy.base`: the shared base stack (one database server, one broker) and a service that reads it; both modules validate. GCP and Azure gave a configuration error in 3.2.2 (X-09b) | 386 s, 103 s, 168 s |
| `terraform-aws-bff`, `terraform-gcp-bff`, `terraform-azure-bff` (new) | `hashicorp/terraform:1.16.6` | `stack.role: "bff"` (Spring on ECS, NestJS on a VM, Express on Container Apps): the BFF gets its own service and no database or broker (X-06b) | 185 s, 52 s, 86 s |
| `helm` | `alpine/helm:3.22.1` | probes, HPA, PDB, relay Deployment (Django) | 2 s |
| `helm-bff` (new) | `alpine/helm:3.22.1` | the BFF chart: no relay Deployment, and the upstream URL (`PAYMENTS_URL`) is set | 3 s |

### 1.5 CI/CD pipelines

| Golden | Image | Check | Time |
|---|---|---|---|
| `ci-github` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the deployment jobs are present (ECS) | 2 s |
| `ci-github-kubernetes` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the Helm deployment is present | 2 s |
| `ci-gitlab` | `python:3.12-slim` | the official GitLab CI schema (`check-jsonschema 0.38.2`) | 8 s |
| `ci-azure-pipelines` | `python:3.12-slim` | the official Azure Pipelines schema | 6 s |

**Result: 94 of 94 goldens pass in a single full run, with no rerun.** They are:

- 39 backends, 18 of them new: the MySQL and MongoDB kernels;
- 4 BFF stacks;
- 20 broker variants;
- 9 frontend and contract stacks;
- 18 deployment goldens, 6 of them new;
- 4 CI goldens.

All 59 backend configurations (39 backends and 20 broker variants) pass IT1–IT7, and every backend image creates its tables in a fresh database. CI repeats this on every change against the packaged tarball, with one job per stack (`.github/workflows/ci.yml`, jobs `package` and `golden-builds`), and `release.yml` publishes only what that pipeline verified.

### 1.6 Database over TLS

Not rerun for 3.3.0 (results of the 3.2.1 run). `node scripts/golden-build.js --db-tls` reruns the backends against a PostgreSQL that accepts only TLS connections (self-signed certificate, `hostssl` only), with `DATABASE_URL=...?sslmode=require`, as managed databases enforce. The integration suites and the production image all connect over TLS.

| Stacks | Result |
|---|---|
| Spring Java (207 s), Spring Kotlin (414 s), Quarkus Java (269 s), Quarkus Kotlin (707 s), ASP.NET Core (78 s), NestJS with Prisma 6 (288 s) and 7 (86 s), Express with Prisma 6 (260 s) and 7 (82 s), FastAPI (265 s), Django (80 s), Go (94 s), Rails (73 s), Phoenix (140 s), Laravel (342 s), Axum (348 s) | 16 of 16 pass |

The MySQL and MongoDB kernels are not covered by `--db-tls`.

### What the runtime integration suite proves

The same seven tests run in every backend, on every database and on every broker. The contract is in [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md).

| Test | Property |
|---|---|
| IT1 | A command writes the aggregate and its outbox row in one transaction; a domain error rolls back both, and the idempotency claim. |
| IT2 | Five concurrent requests with the same idempotency key produce exactly one event and identical responses. |
| IT3 | Two concurrent outbox relays publish 20 events exactly once (leases: `FOR UPDATE SKIP LOCKED` on SQL, `findOneAndUpdate` on MongoDB; broker acknowledgement before marking). |
| IT4 | Tenants with the same aggregate id are isolated. |
| IT5 | A failing saga step compensates the completed steps in reverse order, and the state is persisted. |
| IT6 | The inbox consumer processes a duplicate delivery once, and dead-letters a poison message to the DLQ. |
| IT7 | An incoming W3C `traceparent` flows through the command, outbox, publish and consume spans: same trace id, and correct parent links. |

## 2. `ghk reverse` (beta)

`ghk reverse` reads an existing codebase and proposes characterization features (`@reverse-engineered @characterization @needs-review`) under `.ghe/reverse/`. By default it is deterministic. The LLM is used only with `--assist`, and its output is a patch ([REVERSE.md](REVERSE.md)). It is measured on three corpora, from the most favourable to the least.

### 2.1 Round trip on generated code

For each of the 16 reference projects (section 3), `scripts/reverse-roundtrip.js` compares two models: the one reverse reads back from the code, and the one the generator built from the features. It compares aggregates, commands and events, not wording.

| Stacks | Projects | F1 |
|---|---|---|
| NestJS (4), Express, Spring Boot Java (2), Spring Boot Kotlin, Quarkus, ASP.NET Core (2), Go (chi), Django, Laravel, Rails, Phoenix | 16 | 1.00 in each |

This code was written by gherkin-ai, so the round trip is necessary but not sufficient.

### 2.2 Open-source code gherkin-ai did not write

`scripts/reverse-oss.js` clones RealWorld ("Conduit") apps at the commits pinned in `tests/fixtures/reverse/oss/realworld.json`. It compares the endpoints that `reverse scan` finds with the 19 endpoints of the RealWorld API, after normalizing prefixes and path parameters. The beta threshold is F1 0.80.

| Analyzer | Repository (pinned commit) | Found / expected | Precision | Recall | F1 |
|---|---|---|---|---|---|
| ASP.NET Core | `gothinkster/aspnetcore-realworld-example-app` (`da51ad1`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| FastAPI | `nsidnev/fastapi-realworld-example-app` (`029eb77`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| Go (gin) | `gothinkster/golang-gin-realworld-example-app` (`a41289b`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| NestJS | `lujakob/nestjs-realworld-example-app` (`c1c2cc4`) | 19 / 19 (21 found) | 0.90 | 1.00 | 0.95 |
| Express | `gothinkster/node-express-realworld-example-app` (`30b68e1`) | 19 / 19 (20 found) | 0.95 | 1.00 | 0.97 |
| Spring Boot (Java) | `gothinkster/spring-boot-realworld-example-app` (`ee17e31`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| Quarkus (Java) | `diegocamara/realworld-api-quarkus` (`d4fe769`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| Spring Boot (Kotlin) | `gothinkster/kotlin-spring-realworld-example-app` (`848c29e`) | 19 / 19 | 1.00 | 1.00 | 1.00 |
| Django REST framework (new analyzer) | `gothinkster/django-realworld-example-app` (`29c9d42`) | 18 / 19 | 0.95 | 0.95 | 0.95 |

The Go analyzer first scored below the threshold on this corpus. The gin route groups are passed to registration functions in other packages, so the routes lost their prefix, and `""` and `"/"` counted as two routes. Both cases are fixed and have their own fixture (`tests/fixtures/reverse/go-gin-groups/`).

Every beta analyzer now has at least one app. The NestJS and Express apps expose endpoints the specification does not list (`DELETE /users/{id}`, `GET /`); precision counts them, so 0.90 and 0.95 are not misreadings. The Spring app declares `method = POST` with a static import, which the analyzer first read as `GET` (F1 0.89); it is fixed.

The Django app has no article deletion in its code, and it serves a `PATCH /user` that the specification does not list: both differences are real. The proposals for these nine apps score 94 to 99 on `ghk lint`. Before the fix for duplicated scenarios (GHK004) they scored 69 to 79. They still need review before `accept`, which is what `@needs-review` says. The golden-build dashboard shows the round-trip and open-source scores. The Pages workflow reruns the open-source validation on every build.

### 2.3 The LMS (hand-written services)

These are 23 features and the Spring services written by hand over the kernel. `reverse` scores a mean F1 of 0.35 against the LMS's own features, and behaviour coverage per service is between 0% and 50%. The low F1 mostly measures how far the code has drifted from the features. That drift is what reverse is meant to bring to light. It was 0.38 before message handlers and scheduled jobs were read: the enrollment service has a scheduled job that expires pending enrollment requests, and no LMS feature specifies it.

### 2.4 Invariants and `--assist`

`tests/golden/reverse.test.ts` and the reverse unit tests check:

- two runs produce byte-identical output;
- `scan` and `propose` write nothing outside `.ghe/reverse/` (`git status --porcelain` stays clean);
- no `Then` step without evidence;
- every proposal re-parses;
- `accept --merge` reports a command that a feature declares but the code does not implement, as drift (exit 7).

`reverse --assist` and `lint --assist` were run against a real provider: Google Gemini, `gemini-flash-lite-latest`, the default for `llm.provider: "gemini"` since 3.3.0. Both returned a patch, and the validation rejected a name the model made up (`ShelfBook`) that had no evidence in the code. No other provider was tested. The mocked-provider tests stay in CI.

## 3. Reference projects

Sixteen reference projects (`ghk-test-projects`) cover realistic multi-stack combinations: backend plus frontend, contracts, a real broker, an adversarial security harness, and a Quarkus banking service created with `ghk init --enterprise --industry banking`. On 2026-11-03 every feature of each was regenerated with the 3.3.0 build. Each was then built and tested with the golden-build recipes (`golden-build.js <stack> --project <dir>`, from a clean tree), including the runtime integration suite (IT1–IT7 and the HTTP API) for its backend. Last, its production image had to start against a fresh database, create its tables, answer its liveness and readiness probes with 200 and accept a command.

| Project | Backend check | Production image | Frontend / contracts check | Result |
|---|---|---|---|---|
| transactional-system | ASP.NET Core 8 + IT1–IT7 (139 s) | healthy | AWS CDK synth + tests (352 s) | pass |
| ts01-java-springboot-vue | Spring Boot 4.1 (Java) + IT1–IT7 (521 s) | healthy | Vue 3 (130 s) | pass |
| ts02-nestjs-react-nextjs | NestJS + IT1–IT7 (968 s) | healthy | Next.js 16 (590 s) | pass |
| ts03-dotnet-angular | ASP.NET Core 8 + IT1–IT7 (136 s) | healthy | Angular 22 (394 s) | pass |
| ts04-django-react-auth | Django + IT1–IT7 (146 s) | healthy | React 19 (122 s) | pass |
| ts05-express-angular-auth | Express 5 + IT1–IT7 (654 s) | healthy | Angular 22 (382 s) | pass |
| ts06-go-chi-react | Go (chi) + IT1–IT7 (119 s) | healthy | React 19 (106 s) | pass |
| ts07-kotlin-springboot-vue | Spring Boot 4.1 (Kotlin) + IT1–IT7 (1165 s) | healthy | Vue 3 (154 s) | pass |
| ts08-laravel-inertia-vue | Laravel 13 + IT1–IT7 (853 s) | healthy | Vue 3 (105 s) | pass |
| ts09-rails-react-auth | Rails 8 + IT1–IT7 (340 s) | healthy | React 19 (123 s) | pass |
| ts10-elixir-phoenix-liveview | Phoenix LiveView + IT1–IT7 (562 s) | healthy | (LiveView, same project) | pass |
| ts11-java-springboot-reactnative | Spring Boot 4.1 (Java) + IT1–IT7 (371 s) | healthy | React Native / Expo 57 (430 s) | pass |
| ts12-grpc-graphql-contracts | NestJS + IT1–IT7 (949 s) | healthy | buf + GraphQL validation (19 s) | pass |
| ts13-real-broker-saga-outbox | NestJS + IT1–IT7 (909 s) | healthy | – | pass |
| ts14-adversarial-security-harness | NestJS + IT1–IT7 (541 s) | healthy | – | pass |
| ts15-quarkus-banking | Quarkus 3.40 LTS on the Pub/Sub emulator + IT1–IT7 (719 s) | healthy | – | pass |

**Result: 16 of 16 projects pass, with 28 of 28 stack checks** (`verify-projects.js --jobs 3`: three projects at a time, so the times are longer than in a serial run).

A second `ghk generate` over each regenerated project changes no file, and `ghk reverse` reads each one back with F1 1.00 (section 2.1). 14 of the 16 projects declared `stack.database: "mysql"` while their kernel ran on PostgreSQL, and their `docker-compose.yml` started a MySQL the service never used (M-04). The compose file, `.env.example` and Prisma now follow the kernel's database, and the 14 declarations were corrected to `"postgresql"`.

## 4. Regenerating an implemented service

The goldens above generate new projects. `tests/golden/implemented-service.test.ts` (CI job `golden-implemented`) covers the other case: a service that a team has already implemented on top of generated code. Its fixture is an LMS service as it was before its 3.2 upgrade (`.ghk-implemented`, an edited 3.0 kernel, its own aggregate, step definitions and `application.yml`), with the inventory of its last generation. The table is from the 3.2.1 run; the CI job repeats it on every change.

| Check | 3.2.0 | 3.2.1 |
|---|---|---|
| Files `generate` creates next to the service's code | 32 (second aggregate, tenant filter, second DataSource and outbox relay, duplicate step definitions, `application.properties`, 10 DTOs) | 3, the per-feature contracts |
| `upgrade --apply` then `mvn test-compile` | compilation error (new kernel files against the kept kernel) | compiles; the new kernel waits in `.ghk-new` (`kernel.pending-merge`) |
| A second `generate` | – | changes nothing |
| A state renamed in the feature only (mutation M5) | `converge` 62, as unmutated | `spec-changed`: exit 7 |
| A route renamed in the controller only (M6), `converge --live` | `converge` 62 | `live-contract`: exit 7 |

The same upgrade was repeated on the real service: `mvn clean test` passes right after `upgrade --apply` (24 of 24), and its integration suite passes (7 of 7 kernel, 2 of 2 service).

In 3.2.2 `converge` passed a scaffold whose steps were still pending, as if it were implemented (LMS-21); it no longer does. On the LMS with 3.3.0, `lint --all` scores 23 of 23 features (minimum 99), and `converge --all` scores 80 or more in 17 of 23, as with 3.2.2.

## 5. The CLI itself

| Check | Result |
|---|---|
| Unit and integration tests (`vitest`) | 1206 tests passing, 1 skipped (Maven opt-in) |
| Type check (`tsc --noEmit`) | clean |
| CI matrix | Linux, macOS and Windows × Node.js 22, 24 and 26 |
| Brownfield adoption (`tests/golden/brownfield.test.ts`) | an Express and a Spring repository without `ghk init`, without a terminal: `detect`, `validate`, `converge` (also `--openapi`), `risk`, `firewall check`, feature resolution, `lint` and `converge` without features, and no files left behind; 18 of 18 pass |
| Corporate proxy | `network.proxy` and `network.caFile` apply on Node.js 22, 24 and 26 |
| CLI contract tests | the built binary is run with `--json` for each command; exit codes and the JSON envelope are asserted |
| Agent firewall | 48 command-evasion vectors (`tests/security/firewall-evasion.test.ts`), none allowed; one write verdict for the firewall, the repair-loop guardrails and the MCP governance check (`tests/security/policy-consistency.test.ts`). `ghk reverse accept` goes through the firewall and is not exposed over MCP |
| Startup migration | 12 concurrent migrations of an empty PostgreSQL 17 database, 3 rounds: 0 of 36 fail with the advisory lock, 17 of 36 without it. MySQL uses `GET_LOCK` on a single connection |
| Dependency audit | `npm audit --audit-level=high`: 0 vulnerabilities; blocking in CI and in the release |
| Release preflight | `npm run release:preflight` on `40219a5` in a clean worktree: npm ci, build, golden matrix (94 stacks), JSON Schemas, type check, audit, `npm publish --dry-run`, actionlint and the quick goldens; 9 of 9 pass |

## 6. What this report does not claim

- **Agent outcome quality.** Whether an agent implements a feature better with gherkin-ai than without it depends on the model, the agent and the task. gherkin-ai ships a harness to measure this on your own tasks (`ghk bench`, [ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)) and does not publish benchmark numbers of its own.
- **Production readiness of generated code.** Generated projects are verified starting points. They build, their tests pass, the runtime kernel passes its integration contract and the image starts and exports traces. The business logic in the BDD steps is left pending, for your team to implement.
- **That `ghk reverse` describes intended behaviour.** It describes what the code does today, from evidence in the code. Its proposals are characterization features for a person to review. The open-source corpus measures endpoints only, on three apps; commands, events and states are measured on the reference projects and the LMS.
- **`--assist` with providers other than Gemini.** The other providers share the same client and validation, but no real run with them is recorded.
- **Cloud deployments.** The Terraform and Helm targets are validated and linted, not applied: no golden creates cloud resources. The CI/CD pipelines are checked against actionlint and the official schemas, not run in the providers.
- **Stacks outside the matrix.** Combinations not listed in section 1 generate contracts and prompts only, and are labeled experimental.

## 7. Reproducing

```bash
npm ci && npm run build
node scripts/golden-build.js                 # all stacks (Docker required)
node scripts/golden-build.js java-mongo go-mysql   # selected stacks
node scripts/golden-build.js --db-tls java   # against a TLS-only PostgreSQL
node scripts/golden-build.js nestjs --keep   # keep the generated project for inspection
node scripts/golden-build.js --no-image go   # skip the production image step
node scripts/golden-build.js --list          # stacks and images
node scripts/reverse-oss.js                  # ghk reverse on the pinned open-source apps (git required)
npm test                                     # the CLI's own suite
```

Each stack's full log is written to the system temp directory as `ghk-golden-<stack>.log`.
