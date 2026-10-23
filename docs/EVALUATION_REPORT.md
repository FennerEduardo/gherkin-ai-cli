# Verification evidence — gherkin-ai 3.2.0

This document lists what is verified for each release, how it is verified, and how to reproduce it. Every result below comes from a command you can run yourself; nothing is scored by hand.

**Run of record:** 2026-10-20, gherkin-ai 3.2.0 (branch `feat/3.2.0`).

**Environment:**

- Windows 11 with Docker Desktop (WSL 2 backend);
- the official toolchain images listed below;
- PostgreSQL `postgres:17-alpine` and RabbitMQ `rabbitmq:4-alpine` for the integration suites, plus the official emulators or brokers of the broker variants: the Pub/Sub emulator (`google-cloud-cli:emulators`), the Service Bus emulator with Azure SQL Edge, and `apache/kafka:4.1.0` (single-node KRaft).

## 1. Golden builds: every stable stack

`scripts/golden-build.js` takes the following steps for each stack in `scripts/golden-stacks.js`:

1. generates a project with the CLI, from `scripts/golden-feature.feature` (and, for backends and frontends, a second feature in the same service);
2. builds it inside the stack's official image;
3. runs its generated unit, contract and BDD tests;
4. for backends, runs the runtime integration suite (IT1–IT7) and the HTTP integration tests against real PostgreSQL and the stack's broker;
5. for backends, builds the production image (`Dockerfile`), starts it next to an OpenTelemetry collector, requires its liveness and readiness probes to answer 200, sends one command with a JWT (HTTP 202), and requires the service's spans to reach the collector over OTLP.

A stack passes only if every step exits with code 0. Pending BDD steps are allowed; failing or erroring tests are not. Deployment and CI goldens run their tools instead (sections 1.4 and 1.5).

### 1.1 Backends

| Stack | Image | Build + generated tests | IT1–IT7 + HTTP | Production image + OTLP | Time |
|---|---|---|---|---|---|
| NestJS 11 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 424 s |
| NestJS 12 + Prisma 7 (ESM) | `node:24-bookworm` | pass | pass | pass | 580 s |
| NestJS 12 + Prisma 6 (ESM) | `node:24-bookworm` | pass | pass | pass | 556 s |
| NestJS 11 + Prisma 7 (MySQL adapter) | `node:24-bookworm` | pass | pass | pass | 393 s |
| Express 5 + Prisma 6 | `node:24-bookworm` | pass | pass | pass | 446 s |
| Express 5 + Prisma 7 | `node:24-bookworm` | pass | pass | pass | 470 s |
| ASP.NET Core 8 | `mcr.microsoft.com/dotnet/sdk:8.0` | pass | pass | pass | 95 s |
| Spring Boot 4.1 (Java, Maven) | `maven:3.9-eclipse-temurin-17` | pass | pass | pass | 238 s |
| Spring Boot 4.1 (Kotlin, Gradle) | `gradle:8.14-jdk17` | pass | pass | pass | 531 s |
| Quarkus 3.40 LTS (Java, Maven) | `maven:3.9-eclipse-temurin-21` | pass | pass | pass | 133 s |
| Quarkus 3.40 LTS (Kotlin, Gradle) | `gradle:8.14-jdk21` | pass | pass | pass | 688 s |
| FastAPI | `python:3.12-slim` | pass | pass | pass | 99 s |
| Django + DRF | `python:3.12-slim` | pass | pass | pass | 94 s |
| Go (chi) | `golang:1.26` | pass | pass | pass | 97 s |
| Laravel 13 | `composer:2` (+ pdo_pgsql, sockets) | pass | pass | pass | 689 s |
| Rails 8 | `ruby:3.3` | pass | pass | pass | 95 s |
| Phoenix | `elixir:1.17` | pass | pass | pass | 348 s |
| Phoenix LiveView | `elixir:1.17` | pass | pass | pass | 384 s |
| Axum (Rust) | `rust:1.99` | pass | pass | pass | 458 s |

### 1.2 Broker adapters

The same backend, build and tests, with the runtime kernel on another broker. IT1–IT7 run through the broker ports.

| Broker | Stacks (golden) | Broker under test | Result |
|---|---|---|---|
| Google Cloud Pub/Sub | NestJS (510 s), Quarkus (295 s), .NET (139 s), FastAPI (162 s), Go (134 s), Rust (405 s), Rails (235 s), Phoenix (322 s), Laravel (736 s) | official emulator | 9 of 9 pass |
| Azure Service Bus | NestJS (717 s), Quarkus (365 s), .NET (247 s), FastAPI (217 s), Go (160 s) | official emulator + Azure SQL Edge | 5 of 5 pass |
| Apache Kafka | Spring Java (335 s), Quarkus (410 s), NestJS (908 s), .NET (88 s), FastAPI (131 s), Go (224 s) | `apache/kafka:4.1.0`, single node | 6 of 6 pass |

The Spring Java and Quarkus Kafka goldens failed in the full run. A new consumer waited for its partitions longer than IT7's one-second drain under the full run's load. The adapters now wait for the partition assignment (commit `775a651`), and all six Kafka goldens passed in the rerun; their times are from that rerun.

### 1.3 Frontends and contracts

| Stack | Image | Check | Time |
|---|---|---|---|
| React 19 | `node:24-bookworm` | build and tests, including `traceparent` tests | 134 s |
| Vue 3 | `node:24-bookworm` | build and tests, including `traceparent` tests | 102 s |
| Angular 22 | `node:24-bookworm` | build and tests, including `traceparent` tests | 279 s |
| Next.js 16 | `node:24-bookworm` | build and tests, including `traceparent` tests | 377 s |
| React Native (Expo 57) | `node:24-bookworm` | build and tests, including `traceparent` tests | 379 s |
| Flutter (standalone app) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 56 s |
| Flutter (frontend) | `ghcr.io/cirruslabs/flutter:stable` | build and tests, including `traceparent` tests | 50 s |
| gRPC + GraphQL contracts | `node:24-bookworm` | `buf build`, `buf lint`, graphql-js validation | 195 s |
| AWS CDK (opt-in, legacy) | `node:24-bookworm` | CDK assertion tests and `cdk synth` | 195 s |

### 1.4 Deployment targets

Nothing is applied. Terraform runs `init -backend=false`, `validate` and `fmt -check`; Helm runs `lint --strict` and `template` for every environment.

| Golden | Image | Covers | Time |
|---|---|---|---|
| `terraform-aws` | `hashicorp/terraform:1.16.6` | ECS Fargate, ALB, RDS, Amazon MQ, Secrets Manager; separate relay (Rails) | 346 s |
| `terraform-gcp` | `hashicorp/terraform:1.16.6` | Cloud Run, Cloud SQL, Pub/Sub, Secret Manager; relay worker pool (Laravel) | 83 s |
| `terraform-azure` | `hashicorp/terraform:1.16.6` | Container Apps, PostgreSQL Flexible, Service Bus, Key Vault (NestJS) | 120 s |
| `terraform-azure-rabbitmq` | `hashicorp/terraform:1.16.6` | Azure with an external RabbitMQ (Phoenix) | 77 s |
| `terraform-aws-kafka`, `terraform-gcp-kafka`, `terraform-azure-kafka` | `hashicorp/terraform:1.16.6` | an existing Kafka cluster on each cloud, no native broker | 214 s, 91 s, 112 s |
| `helm` | `alpine/helm:3.22.1` | probes, HPA, PDB, relay Deployment (Django) | 10 s |

### 1.5 CI/CD pipelines

| Golden | Image | Check | Time |
|---|---|---|---|
| `ci-github` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the deployment jobs are present (ECS) | 9 s |
| `ci-github-kubernetes` | `rhysd/actionlint:1.7.12` | actionlint with shellcheck; the Helm deployment is present | 9 s |
| `ci-gitlab` | `python:3.12-slim` | the official GitLab CI schema (`check-jsonschema 0.38.2`) | 17 s |
| `ci-azure-pipelines` | `python:3.12-slim` | the official Azure Pipelines schema | 15 s |

**Result: 60 of 60 goldens pass**: 19 backends, 20 broker variants, 9 frontend and contract stacks, 8 deployment and 4 CI goldens. All 39 backend configurations (19 backends and 20 broker variants) pass IT1–IT7. CI repeats this on every change, with one job per stack (`.github/workflows/ci.yml`, job `golden-builds`).

### 1.6 Database over TLS

`node scripts/golden-build.js --db-tls` reruns the backends against a PostgreSQL that accepts only TLS connections (self-signed certificate, `hostssl` only), with `DATABASE_URL=...?sslmode=require`, as managed databases enforce. The integration suites and the production image all connect over TLS.

| Stacks | Result |
|---|---|
| Spring Java, Spring Kotlin, Quarkus Java, Quarkus Kotlin, ASP.NET Core, NestJS (Prisma 6 and 7), Express (Prisma 6 and 7), FastAPI, Django, Go, Rails, Phoenix, Laravel, Axum | 16 of 16 pass |

The first run found that the generated TypeScript tests and the Prisma 7 adapter passed the URL to node-postgres unchanged, which treats `sslmode=require` as `verify-full`; they now add `uselibpqcompat=true`, and the rerun passed. The Quarkus production image also failed once in the first run, while Maven downloaded its dependencies inside `docker build`, after the integration tests had passed over TLS; it passed in the rerun.

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

Sixteen reference projects (`ghk-test-projects`, branch `ghk-3.2`) cover realistic multi-stack combinations: backend plus frontend, contracts, a real broker, an adversarial security harness, and a Quarkus banking service created with `ghk init --enterprise --industry banking`. On 2026-10-23 they were regenerated from scratch with 3.2.0. Each was then built and tested with the golden-build recipes, including the runtime integration suite (IT1–IT7 and the HTTP API) for its backend. Last, its production image had to start against PostgreSQL and the broker and answer its liveness and readiness probes with 200.

| Project | Backend check | Production image | Frontend / contracts check | Result |
|---|---|---|---|---|
| transactional-system | ASP.NET Core 8 + IT1–IT7 (47 s) | healthy | AWS CDK synth + tests (160 s) | pass |
| ts01-java-springboot-vue | Spring Boot 4.1 (Java) + IT1–IT7 (208 s) | healthy | Vue 3 (144 s) | pass |
| ts02-nestjs-react-nextjs | NestJS + IT1–IT7 (755 s) | healthy | Next.js 16 (289 s) | pass |
| ts03-dotnet-angular | ASP.NET Core 8 + IT1–IT7 (128 s) | healthy | Angular 22 (198 s) | pass |
| ts04-django-react-auth | Django + IT1–IT7 (42 s) | healthy | React 19 (56 s) | pass |
| ts05-express-angular-auth | Express 5 + IT1–IT7 (429 s) | healthy | Angular 22 (268 s) | pass |
| ts06-go-chi-react | Go (chi) + IT1–IT7 (29 s) | healthy | React 19 (83 s) | pass |
| ts07-kotlin-springboot-vue | Spring Boot 4.1 (Kotlin) + IT1–IT7 (274 s) | healthy | Vue 3 (68 s) | pass |
| ts08-laravel-inertia-vue | Laravel 13 + IT1–IT7 (926 s) | healthy | Vue 3 (65 s) | pass |
| ts09-rails-react-auth | Rails 8 + IT1–IT7 (200 s) | healthy | React 19 (59 s) | pass |
| ts10-elixir-phoenix-liveview | Phoenix LiveView + IT1–IT7 (262 s) | healthy | (LiveView, same project) | pass |
| ts11-java-springboot-reactnative | Spring Boot 4.1 (Java) + IT1–IT7 (80 s) | healthy | React Native / Expo 57 (301 s) | pass |
| ts12-grpc-graphql-contracts | NestJS + IT1–IT7 (579 s) | healthy | buf + GraphQL validation (13 s) | pass |
| ts13-real-broker-saga-outbox | NestJS + IT1–IT7 (555 s) | healthy | – | pass |
| ts14-adversarial-security-harness | NestJS + IT1–IT7 (546 s) | healthy | – | pass |
| ts15-quarkus-banking | Quarkus 3.40 LTS on the Pub/Sub emulator + IT1–IT7 (115 s) | healthy | – | pass |

**Result: 16 of 16 projects pass, with 28 of 28 stack checks.** In the first run, the production image builds of ts12, ts13 and ts14 timed out while Docker resolved the `node:24-bookworm-slim` base image (`DeadlineExceeded`); their builds and integration suites had already passed. They passed in the rerun, and their times are from that rerun.

A second `ghk generate` over each regenerated project changes no file. `ghk validate` passes in all 16 projects. Compared with the 3.2.0 regeneration of 2026-10-18, `ghk lint` scores ten projects one point lower. The cause is the new informational rule GHK016: their commands are written in Spanish steps, which the generator cannot name, so the API exposes a generic `process_<aggregate>` command. ts01, ts03, ts06 and ts07 are also written in Spanish but keep their scores, because their steps name the command (`"CreateOrderCommand"`). ts15 declares its command and event with `@command:ExecutePayment @event:PaymentExecuted`. It keeps 99/100, its API exposes `execute_payment`, and `ghk converge` rises from 87% to 97% (traceability from 44% to 100%). Two later lint fixes then raised two scores by five points: GHK007 no longer reports the word "service" (ts01, 83/100), and GHK009 recognizes a rejected outcome as an error path (ts13, 78/100). Each project's README lists its own results.

`ghk verify --services` was also run on copies of ts15 (Quarkus, Pub/Sub emulator) and ts06 (Go, RabbitMQ). It now starts the project's broker and runs in the generated project. ts15 passes its integration suite. ts06 passes its tests, and the command then exits 4 at its convergence gate (64% against 80%), as designed.

## 3. The CLI itself

| Check | Result |
|---|---|
| Unit and integration tests (`vitest`) | 791 tests, all passing |
| Type check (`tsc --noEmit`) | clean |
| CI matrix | Linux, macOS and Windows × Node.js 22 and 24 |
| CLI contract tests | the built binary is run with `--json` for each command; exit codes and the JSON envelope are asserted |
| Dependency audit | `npm audit --audit-level=high` is blocking in CI |

## 4. What this report does not claim

- **Agent outcome quality.** Whether an agent implements a feature better with gherkin-ai than without it depends on the model, the agent and the task. gherkin-ai ships a harness to measure this on your own tasks (`ghk bench`, [ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)) and does not publish benchmark numbers of its own.
- **Production readiness of generated code.** Generated projects are verified starting points. They build, their tests pass, the runtime kernel passes its integration contract and the image starts and exports traces. The business logic in the BDD steps is left pending, for your team to implement.
- **Cloud deployments.** The Terraform and Helm targets are validated and linted, not applied: no golden creates cloud resources. The CI/CD pipelines are checked against actionlint and the official schemas, not run in the providers.
- **Stacks outside the matrix.** Combinations not listed in section 1 generate contracts and prompts only, and are labeled experimental.

## 5. Reproducing

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
