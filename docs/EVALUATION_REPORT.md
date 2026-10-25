# Verification evidence — gherkin-ai 3.2.1

This document lists what is verified for each release, how it is verified, and how to reproduce it. Every result below comes from a command you can run yourself; nothing is scored by hand.

**Run of record:** 2026-10-24/25, gherkin-ai 3.2.1 (branch `fix/3.2.1`). The CLI under test is the packaged tarball (`npm pack`, installed in a clean directory and passed to the goldens as `GHK_CLI`), the file `release.yml` publishes. The 3.2.0 report is in the git history of this file.

**Environment:**

- Ubuntu on WSL 2 with Docker Engine 29.9.2 (Linux, as on the CI runners);
- the official toolchain images listed below;
- PostgreSQL `postgres:17-alpine` and RabbitMQ `rabbitmq:4-alpine` for the integration suites, plus the official emulators or brokers of the broker variants: the Pub/Sub emulator (`google-cloud-cli:emulators`), the Service Bus emulator with Azure SQL Edge, and `apache/kafka:4.1.0` (single-node KRaft).

## 1. Golden builds: every stable stack

`scripts/golden-build.js` takes the following steps for each stack in `scripts/golden-stacks.js`:

1. generates a project with the CLI, from `scripts/golden-feature.feature` (and, for backends and frontends, a second feature in the same service);
2. builds it inside the stack's official image;
3. runs its generated unit, contract and BDD tests;
4. for backends, runs the runtime integration suite (IT1–IT7) and the HTTP integration tests against real PostgreSQL and the stack's broker;
5. for backends, builds the production image (`Dockerfile`), starts it against a **fresh database** (the service must create the runtime kernel's tables itself, as in a first deployment) next to an OpenTelemetry collector, requires its liveness and readiness probes to answer 200, sends one command with a JWT (HTTP 202), and requires the service's spans to reach the collector over OTLP.

Until 3.2.1 the image started against the database the integration suite had just migrated, which hid that no backend created its tables at startup (CHANGELOG 3.2.1).

A stack passes only if every step exits with code 0. Pending BDD steps are allowed; failing or erroring tests are not. Deployment and CI goldens run their tools instead (sections 1.4 and 1.5).

### 1.1 Backends

| Stack | Image | Build + generated tests | IT1–IT7 + HTTP | Production image + OTLP | Time |
|---|---|---|---|---|---|
| NestJS 11 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 288 s |
| NestJS 12 + Prisma 7 (ESM) | `node:24-bookworm` | pass | pass | pass | 289 s |
| NestJS 12 + Prisma 6 (ESM) | `node:24-bookworm` | pass | pass | pass | 282 s |
| NestJS 11 + Prisma 7 (MySQL adapter) | `node:24-bookworm` | pass | pass | pass | 260 s |
| Express 5 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 233 s |
| Express 5 + Prisma 7 | `node:24-bookworm` | pass | pass | pass | 239 s |
| ASP.NET Core 8 | `mcr.microsoft.com/dotnet/sdk:8.0` | pass | pass | pass | 76 s |
| Spring Boot 4.1 (Java, Maven) | `maven:3.9-eclipse-temurin-17` | pass | pass | pass | 226 s |
| Spring Boot 4.1 (Kotlin, Gradle) | `gradle:8.14-jdk17` | pass | pass | pass | 442 s |
| Quarkus 3.40 LTS (Java, Maven) | `maven:3.9-eclipse-temurin-21` | pass | pass | pass | 287 s |
| Quarkus 3.40 LTS (Kotlin, Gradle) | `gradle:8.14-jdk21` | pass | pass | pass | 622 s |
| FastAPI | `python:3.12-slim` | pass | pass | pass | 83 s |
| Django + DRF | `python:3.12-slim` | pass | pass | pass | 81 s |
| Go (chi) | `golang:1.26` | pass | pass | pass | 83 s |
| Laravel 13 | `composer:2` (+ pdo_pgsql, sockets) | pass | pass | pass | 432 s |
| Rails 8 | `ruby:3.3` | pass | pass | pass | 71 s |
| Phoenix | `elixir:1.17` | pass | pass | pass | 117 s |
| Phoenix LiveView | `elixir:1.17` | pass | pass | pass | 128 s |
| Axum (Rust) | `rust:1.99` | pass | pass | pass | 985 s |

### 1.2 Broker adapters

The same backend, build and tests, with the runtime kernel on another broker. IT1–IT7 run through the broker ports.

| Broker | Stacks (golden) | Broker under test | Result |
|---|---|---|---|
| Google Cloud Pub/Sub | NestJS (278 s), Quarkus (347 s), .NET (95 s), FastAPI (73 s), Go (87 s), Rust (900 s), Rails (77 s), Phoenix (146 s), Laravel (319 s) | official emulator | 9 of 9 pass |
| Azure Service Bus | NestJS (385 s), Quarkus (349 s), .NET (172 s), FastAPI (137 s), Go (136 s) | official emulator + Azure SQL Edge | 5 of 5 pass |
| Apache Kafka | Spring Java (282 s), Quarkus (365 s), NestJS (312 s), .NET (126 s), FastAPI (86 s), Go (174 s) | `apache/kafka:4.1.0`, single node | 6 of 6 pass |

In the full run the Quarkus Kafka golden failed IT7, and it failed again in one of two reruns: after the partition assignment the JVM subscription reported an empty source before its first fetch completed, so a consumer draining right after a publish could miss the record (an earlier fix, `775a651`, only waited for the assignment). It now keeps reading while the position is behind the end offset (commit `79222c6`); the Quarkus golden then passed 3 of 3 consecutive runs (365 s, 140 s, 120 s) and Spring Java passed too. Their times are from those runs.

### 1.3 Frontends and contracts

| Stack | Image | Check | Time |
|---|---|---|---|
| React 19 | `node:24-bookworm` | build and tests, including `traceparent` tests | 42 s |
| Vue 3 | `node:24-bookworm` | build and tests, including `traceparent` tests | 31 s |
| Angular 22 | `node:24-bookworm` | build and tests, including `traceparent` tests | 67 s |
| Next.js 16 | `node:24-bookworm` | build and tests, including `traceparent` tests | 38 s |
| React Native (Expo 57) | `node:24-bookworm` | build and tests, including `traceparent` tests | 74 s |
| Flutter (standalone app) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 27 s |
| Flutter (frontend) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 25 s |
| gRPC + GraphQL contracts | `node:24-bookworm` | `buf build`, `buf lint`, graphql-js validation | 99 s |
| AWS CDK (opt-in, legacy) | `node:24-bookworm` | CDK assertion tests and `cdk synth` | 23 s |

### 1.4 Deployment targets

Nothing is applied. Terraform runs `init -backend=false`, `validate` and `fmt -check`; Helm runs `lint --strict` and `template` for every environment.

| Golden | Image | Covers | Time |
|---|---|---|---|
| `terraform-aws` | `hashicorp/terraform:1.16.6` | ECS Fargate, ALB, RDS, Amazon MQ, Secrets Manager; separate relay (Rails) | 194 s |
| `terraform-gcp` | `hashicorp/terraform:1.16.6` | Cloud Run, Cloud SQL, Pub/Sub, Secret Manager; relay worker pool (Laravel) | 50 s |
| `terraform-azure` | `hashicorp/terraform:1.16.6` | Container Apps, PostgreSQL Flexible, Service Bus, Key Vault (NestJS) | 80 s |
| `terraform-azure-rabbitmq` | `hashicorp/terraform:1.16.6` | Azure with an external RabbitMQ (Phoenix) | 78 s |
| `terraform-aws-kafka`, `terraform-gcp-kafka`, `terraform-azure-kafka` | `hashicorp/terraform:1.16.6` | an existing Kafka cluster on each cloud, no native broker | 250 s, 65 s, 142 s |
| `helm` | `alpine/helm:3.22.1` | probes, HPA, PDB, relay Deployment (Django) | 2 s |

### 1.5 CI/CD pipelines

| Golden | Image | Check | Time |
|---|---|---|---|
| `ci-github` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the deployment jobs are present (ECS) | 1 s |
| `ci-github-kubernetes` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the Helm deployment is present | 1 s |
| `ci-gitlab` | `python:3.12-slim` | the official GitLab CI schema (`check-jsonschema 0.38.2`) | 7 s |
| `ci-azure-pipelines` | `python:3.12-slim` | the official Azure Pipelines schema | 7 s |

**Result: 60 of 60 goldens pass**: 19 backends, 20 broker variants, 9 frontend and contract stacks, 8 deployment and 4 CI goldens. All 39 backend configurations (19 backends and 20 broker variants) pass IT1–IT7, and every backend image creates its tables in a fresh database. CI repeats this on every change against the packaged tarball, with one job per stack (`.github/workflows/ci.yml`, jobs `package` and `golden-builds`), and `release.yml` publishes only what that pipeline verified.

### 1.6 Database over TLS

`node scripts/golden-build.js --db-tls` reruns the backends against a PostgreSQL that accepts only TLS connections (self-signed certificate, `hostssl` only), with `DATABASE_URL=...?sslmode=require`, as managed databases enforce. The integration suites and the production image all connect over TLS.

| Stacks | Result |
|---|---|
| Spring Java (207 s), Spring Kotlin (414 s), Quarkus Java (269 s), Quarkus Kotlin (707 s), ASP.NET Core (78 s), NestJS with Prisma 6 (288 s) and 7 (86 s), Express with Prisma 6 (260 s) and 7 (82 s), FastAPI (265 s), Django (80 s), Go (94 s), Rails (73 s), Phoenix (140 s), Laravel (342 s), Axum (348 s) | 16 of 16 pass |

With 3.2.1 the production image also creates its tables over TLS, in a fresh database, when it starts. In the 3.2.0 run, the first pass found that the generated TypeScript tests and the Prisma 7 adapter passed the URL to node-postgres unchanged, which treats `sslmode=require` as `verify-full`; they add `uselibpqcompat=true` since then.

### What the runtime integration suite proves

The same seven tests run in every backend and on every broker. The contract is in [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md).

| Test | Property |
|---|---|
| IT1 | A command writes the aggregate and its outbox row in one transaction; a domain error rolls back both, and the idempotency claim. |
| IT2 | Five concurrent requests with the same idempotency key produce exactly one event and identical responses. |
| IT3 | Two concurrent outbox relays publish 20 events exactly once (`FOR UPDATE SKIP LOCKED` leases, broker acknowledgement before marking). |
| IT4 | Tenants with the same aggregate id are isolated. |
| IT5 | A failing saga step compensates the completed steps in reverse order, and the state is persisted. |
| IT6 | The inbox consumer processes a duplicate delivery once, and dead-letters a poison message to the DLQ. |
| IT7 | An incoming W3C `traceparent` flows through the command, outbox, publish and consume spans: same trace id, and correct parent links. |

## 2. Reference projects

Sixteen reference projects (`ghk-test-projects`) cover realistic multi-stack combinations: backend plus frontend, contracts, a real broker, an adversarial security harness, and a Quarkus banking service created with `ghk init --enterprise --industry banking`. On 2026-10-24/25 every feature of each was regenerated with the 3.2.1 tarball. Each was then built and tested with the golden-build recipes (`golden-build.js <stack> --project <dir>`, from a clean tree), including the runtime integration suite (IT1–IT7 and the HTTP API) for its backend. Last, its production image had to start against a fresh database, create its tables, answer its liveness and readiness probes with 200 and accept a command.

| Project | Backend check | Production image | Frontend / contracts check | Result |
|---|---|---|---|---|
| transactional-system | ASP.NET Core 8 + IT1–IT7 (83 s) | healthy | AWS CDK synth + tests (26 s) | pass |
| ts01-java-springboot-vue | Spring Boot 4.1 (Java) + IT1–IT7 (213 s) | healthy | Vue 3 (28 s) | pass |
| ts02-nestjs-react-nextjs | NestJS + IT1–IT7 (306 s) | healthy | Next.js 16 (54 s) | pass |
| ts03-dotnet-angular | ASP.NET Core 8 + IT1–IT7 (86 s) | healthy | Angular 22 (45 s) | pass |
| ts04-django-react-auth | Django + IT1–IT7 (81 s) | healthy | React 19 (15 s) | pass |
| ts05-express-angular-auth | Express 5 + IT1–IT7 (155 s) | healthy | Angular 22 (48 s) | pass |
| ts06-go-chi-react | Go (chi) + IT1–IT7 (81 s) | healthy | React 19 (16 s) | pass |
| ts07-kotlin-springboot-vue | Spring Boot 4.1 (Kotlin) + IT1–IT7 (395 s) | healthy | Vue 3 (26 s) | pass |
| ts08-laravel-inertia-vue | Laravel 13 + IT1–IT7 (308 s) | healthy | Vue 3 (25 s) | pass |
| ts09-rails-react-auth | Rails 8 + IT1–IT7 (68 s) | healthy | React 19 (16 s) | pass |
| ts10-elixir-phoenix-liveview | Phoenix LiveView + IT1–IT7 (128 s) | healthy | (LiveView, same project) | pass |
| ts11-java-springboot-reactnative | Spring Boot 4.1 (Java) + IT1–IT7 (209 s) | healthy | React Native / Expo 57 (85 s) | pass |
| ts12-grpc-graphql-contracts | NestJS + IT1–IT7 (261 s) | healthy | buf + GraphQL validation (7 s) | pass |
| ts13-real-broker-saga-outbox | NestJS + IT1–IT7 (150 s) | healthy | – | pass |
| ts14-adversarial-security-harness | NestJS + IT1–IT7 (261 s) | healthy | – | pass |
| ts15-quarkus-banking | Quarkus 3.40 LTS on the Pub/Sub emulator + IT1–IT7 (281 s) | healthy | – | pass |

**Result: 16 of 16 projects pass, with 28 of 28 stack checks.** An earlier pass of the same day, with the 3.2.1 candidate before the startup migration fix, found the defect this release fixes: the regenerated services passed their builds and IT1–IT7 but, started against a database the integration suite had not migrated, answered 500 (`relation "public.ghk_idempotency" does not exist`).

A second `ghk generate` over each regenerated project changes no file, and `ghk validate` passes in all 16. `ghk lint` scores are the same as with 3.2.0. `ghk converge` is the same in 14 projects; in ts07 (62% to 54%) and ts15 (97% to 92%) the Code Coverage dimension is now measured, from the JaCoCo report the generated JVM builds produce since 3.2.1, instead of being `n/a`. No project reports contract drift. Each project's README lists its own results.

In the 3.2.0 run of record, `ghk verify --services` was also run on a copy of each of the 16 projects, the way a team runs it, and all 16 exited 0 (between 16 s and 438 s). It was not repeated for 3.2.1.

## 3. Regenerating an implemented service

The goldens above generate new projects. `tests/golden/implemented-service.test.ts` (CI job `golden-implemented`) covers the other case: a service that a team has already implemented on top of generated code. Its fixture is an LMS service as it was before its 3.2 upgrade (`.ghk-implemented`, an edited 3.0 kernel, its own aggregate, step definitions and `application.yml`), with the inventory of its last generation.

| Check | 3.2.0 | 3.2.1 |
|---|---|---|
| Files `generate` creates next to the service's code | 32 (second aggregate, tenant filter, second DataSource and outbox relay, duplicate step definitions, `application.properties`, 10 DTOs) | 3, the per-feature contracts |
| `upgrade --apply` then `mvn test-compile` | compilation error (new kernel files against the kept kernel) | compiles; the new kernel waits in `.ghk-new` (`kernel.pending-merge`) |
| A second `generate` | – | changes nothing |
| A state renamed in the feature only (mutation M5) | `converge` 62, as unmutated | `spec-changed`: exit 7 |
| A route renamed in the controller only (M6), `converge --live` | `converge` 62 | `live-contract`: exit 7 |

The same upgrade was repeated on the real service: `mvn clean test` passes right after `upgrade --apply` (24 of 24), and its integration suite passes (7 of 7 kernel, 2 of 2 service).

## 4. The CLI itself

| Check | Result |
|---|---|
| Unit and integration tests (`vitest`) | 954 tests, all passing |
| Type check (`tsc --noEmit`) | clean |
| CI matrix | Linux, macOS and Windows × Node.js 22 and 24 |
| CLI contract tests | the built binary is run with `--json` for each command; exit codes and the JSON envelope are asserted |
| Agent firewall | 48 command-evasion vectors (`tests/security/firewall-evasion.test.ts`), none allowed; one write verdict for the firewall, the repair-loop guardrails and the MCP governance check (`tests/security/policy-consistency.test.ts`) |
| Startup migration | 12 concurrent migrations of an empty PostgreSQL 17 database, 3 rounds: 0 of 36 fail with the advisory lock, 17 of 36 without it |
| Dependency audit | `npm audit --audit-level=high`: 0 vulnerabilities; blocking in CI and in the release |
| Release preflight | `npm run release:preflight` on the candidate in a clean worktree: npm ci, build, golden matrix, JSON Schemas, type check, audit, actionlint and the quick goldens |

## 5. What this report does not claim

- **Agent outcome quality.** Whether an agent implements a feature better with gherkin-ai than without it depends on the model, the agent and the task. gherkin-ai ships a harness to measure this on your own tasks (`ghk bench`, [ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)) and does not publish benchmark numbers of its own.
- **Production readiness of generated code.** Generated projects are verified starting points. They build, their tests pass, the runtime kernel passes its integration contract and the image starts and exports traces. The business logic in the BDD steps is left pending, for your team to implement.
- **Cloud deployments.** The Terraform and Helm targets are validated and linted, not applied: no golden creates cloud resources. The CI/CD pipelines are checked against actionlint and the official schemas, not run in the providers.
- **Stacks outside the matrix.** Combinations not listed in section 1 generate contracts and prompts only, and are labeled experimental.

## 6. Reproducing

```bash
npm ci && npm run build
node scripts/golden-build.js                 # all stacks (Docker required)
node scripts/golden-build.js java rust       # selected stacks
node scripts/golden-build.js --db-tls java   # against a TLS-only PostgreSQL
node scripts/golden-build.js nestjs --keep   # keep the generated project for inspection
node scripts/golden-build.js --no-image go   # skip the production image step
node scripts/golden-build.js --list          # stacks and images
npm test                                     # the CLI's own suite
```

Each stack's full log is written to the system temp directory as `ghk-golden-<stack>.log`.
