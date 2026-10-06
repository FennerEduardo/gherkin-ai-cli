# Verification evidence — gherkin-ai 3.0.0

This document lists what is verified for each release, how it is verified, and how to reproduce it. It replaces the 2.6.3 report, which was a rubric scored by the author. Every result below comes from a command you can run yourself; nothing is scored by hand.

**Run of record:** 2026-10-05, gherkin-ai 3.0.0 (branch `feature/enterprise-3.0`).

**Environment:**

- Windows 11 with Docker Desktop (WSL 2 backend);
- the official toolchain images listed below;
- PostgreSQL `postgres:17-alpine` and RabbitMQ `rabbitmq:4-alpine` for the integration suites.

## 1. Golden builds: every stable stack

`scripts/golden-build.js` takes the following steps for each stack in `scripts/golden-stacks.js`:

1. generates a project from `scripts/golden-feature.feature` with the CLI;
2. builds it inside the stack's official image;
3. runs its generated unit, contract and BDD tests;
4. for backends, runs the runtime integration suite (IT1–IT7) against real PostgreSQL and RabbitMQ containers.

A stack passes only if every step exits with code 0. Pending BDD steps are allowed; failing or erroring tests are not.

| Stack | Image | Build + generated tests | Runtime integration (IT1–IT7) | Result | Time |
|---|---|---|---|---|---|
| NestJS 11 + Prisma 6 | `node:24-bookworm` | pass | 7/7 | pass | 311 s |
| NestJS 12 + Prisma 7 (ESM) | `node:24-bookworm` | pass | 7/7 | pass | 302 s |
| NestJS 12 + Prisma 6 (ESM) | `node:24-bookworm` | pass | 7/7 | pass | 307 s |
| NestJS 11 + Prisma 7 (MySQL adapter) | `node:24-bookworm` | pass | 7/7 | pass | 381 s |
| Express 5 + Prisma 6 | `node:24-bookworm` | pass | 7/7 | pass | 306 s |
| Express 5 + Prisma 7 | `node:24-bookworm` | pass | 7/7 | pass | 244 s |
| ASP.NET Core 8 | `mcr.microsoft.com/dotnet/sdk:8.0` | pass | 7/7 | pass | 61 s |
| Spring Boot 3 (Java, Maven) | `maven:3.9-eclipse-temurin-17` | pass | 7/7 | pass | 74 s |
| Spring Boot 3 (Kotlin, Gradle) | `gradle:8.10-jdk17` | pass | 7/7 | pass | 188 s |
| FastAPI | `python:3.12-slim` | pass | 7/7 | pass | 50 s |
| Django + DRF | `python:3.12-slim` | pass | 7/7 | pass | 45 s |
| Go (chi) | `golang:1.22` | pass | 7/7 | pass | 31 s |
| Laravel 13 | `composer:2` (+ pdo_pgsql, sockets) | pass | 7/7 | pass | 335 s |
| Rails 8 | `ruby:3.3` | pass | 7/7 | pass | 47 s |
| Phoenix | `elixir:1.17` | pass | 7/7 | pass | 187 s |
| Phoenix LiveView | `elixir:1.17` | pass | 7/7 | pass | 168 s |
| Axum (Rust) | `rust:1.99` | pass | 7/7 | pass | 281 s |
| React 19 | `node:24-bookworm` | pass, including `traceparent` tests | – | pass | 83 s |
| Vue 3 | `node:24-bookworm` | pass, including `traceparent` tests | – | pass | 73 s |
| Angular 22 | `node:24-bookworm` | pass, including `traceparent` tests | – | pass | 220 s |
| Next.js 16 | `node:24-bookworm` | pass, including `traceparent` tests | – | pass | 277 s |
| React Native (Expo 57) | `node:24-bookworm` | pass, including `traceparent` tests | – | pass | 293 s |
| Flutter (standalone app) | `ghcr.io/cirruslabs/flutter:stable` | pass, including `traceparent` tests | – | pass | 38 s |
| Flutter (frontend) | `ghcr.io/cirruslabs/flutter:stable` | pass, including `traceparent` tests | – | pass | 32 s |
| gRPC + GraphQL contracts | `node:24-bookworm` | `buf build`, `buf lint`, graphql-js validation | – | pass | 209 s |
| AWS CDK (opt-in) | `node:24-bookworm` | CDK assertion tests and `cdk synth` | – | pass | 195 s |

**Result: 26 of 26 stacks pass, and 17 of 17 backend configurations pass IT1–IT7.** The Express + Prisma 7 build was rerun after its integration step was added to the registry; its time is from that rerun. CI repeats this on every change, with one job per stack (`.github/workflows/ci.yml`, job `golden-builds`).

### What the runtime integration suite proves

The same seven tests run in every backend. The contract is in [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md).

| Test | Property |
|---|---|
| IT1 | A command writes the aggregate and its outbox row in one transaction; a domain error rolls back both, and the idempotency claim. |
| IT2 | Five concurrent requests with the same idempotency key produce exactly one event and identical responses. |
| IT3 | Two concurrent outbox relays publish 20 events exactly once (`FOR UPDATE SKIP LOCKED` leases, publisher confirms). |
| IT4 | Tenants with the same aggregate id are isolated. |
| IT5 | A failing saga step compensates the completed steps in reverse order, and the state is persisted. |
| IT6 | The inbox consumer processes a duplicate delivery once, and dead-letters a poison message to the DLQ. |
| IT7 | An incoming W3C `traceparent` flows through the command, outbox, publish and consume spans: same trace id, and correct parent links. |

## 2. Reference projects

Fifteen reference projects (`ghk-test-projects`, branch `v3`) cover realistic multi-stack combinations: backend plus frontend, contracts, a real broker, and an adversarial security harness. For this release they were regenerated with 3.0.0. Each was then built and tested with the same recipes as the golden builds, including the runtime integration suite for its backend.

| Project | Backend check | Frontend / contracts check | Result |
|---|---|---|---|
| transactional-system | ASP.NET Core 8 + IT1–IT7 (38 s) | – | pass |
| ts01-java-springboot-vue | Spring Boot (Java) + IT1–IT7 (60 s) | Vue 3 (74 s) | pass |
| ts02-nestjs-react-nextjs | NestJS + IT1–IT7 (328 s) | Next.js 16 (265 s) | pass |
| ts03-dotnet-angular | ASP.NET Core 8 + IT1–IT7 (40 s) | Angular 22 (215 s) | pass |
| ts04-django-react-auth | Django + IT1–IT7 (33 s) | React 19 (65 s) | pass |
| ts05-express-angular-auth | Express 5 + IT1–IT7 (246 s) | Angular 22 (210 s) | pass |
| ts06-go-chi-react | Go (chi) + IT1–IT7 (19 s) | React 19 (61 s) | pass |
| ts07-kotlin-springboot-vue | Spring Boot (Kotlin) + IT1–IT7 (161 s) | Vue 3 (73 s) | pass |
| ts08-laravel-inertia-vue | Laravel 13 + IT1–IT7 (385 s) | Vue 3 (67 s) | pass |
| ts09-rails-react-auth | Rails 8 + IT1–IT7 (32 s) | React 19 (69 s) | pass |
| ts10-elixir-phoenix-liveview | Phoenix LiveView + IT1–IT7 (163 s) | (LiveView, same project) | pass |
| ts11-java-springboot-reactnative | Spring Boot (Java) + IT1–IT7 (57 s) | React Native / Expo 57 (332 s) | pass |
| ts12-grpc-graphql-contracts | NestJS + IT1–IT7 (312 s) | buf + GraphQL validation (13 s) | pass |
| ts13-real-broker-saga-outbox | NestJS + IT1–IT7 (316 s) | – | pass |
| ts14-adversarial-security-harness | NestJS + IT1–IT7 (300 s) | – | pass |

**Result: 15 of 15 projects pass, with 25 of 25 stack checks.** Each project's regeneration is committed on its `v3` branch.

## 3. The CLI itself

| Check | Result |
|---|---|
| Unit and integration tests (`vitest`) | 523 tests, all passing |
| Type check (`tsc --noEmit`) | clean |
| CI matrix | Linux, macOS and Windows × Node.js 22 and 24 |
| CLI contract tests | the built binary is run with `--json` for each command; exit codes and the JSON envelope are asserted |
| Dependency audit | `npm audit --audit-level=high` is blocking in CI |

## 4. What this report does not claim

- **Agent outcome quality.** Whether an agent implements a feature better with gherkin-ai than without it depends on the model, the agent and the task. gherkin-ai ships a harness to measure this on your own tasks (`ghk bench`, [ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)) and does not publish benchmark numbers of its own.
- **Production readiness of generated code.** Generated projects are verified starting points. They build, their tests pass and the runtime kernel passes its integration contract. The business logic in the BDD steps is left pending, for your team to implement.
- **Stacks outside the matrix.** Combinations not listed in section 1 generate contracts and prompts only, and are labeled experimental.

## 5. Reproducing

```bash
npm ci && npm run build
node scripts/golden-build.js                 # all stacks (Docker required)
node scripts/golden-build.js java rust       # selected stacks
node scripts/golden-build.js nestjs --keep   # keep the generated project for inspection
node scripts/golden-build.js --list          # stacks and images
npm test                                     # the CLI's own suite
```

Each stack's full log is written to the system temp directory as `ghk-golden-<stack>.log`.
