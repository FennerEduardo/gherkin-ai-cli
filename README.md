# gherkin-ai

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![CI](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Spec-driven verification and governance for AI-assisted software delivery.**

gherkin-ai turns requirements into executable Gherkin specifications and generates verified contracts and code for 20+ stacks. It gates changes on specification quality, drift and delivery risk, and controls what AI coding agents may change.

- **Specify.** Write or import (GitHub Spec Kit) `.feature` files, lint them, and build a semantic model of commands, events, endpoints, states and rules.
- **Generate.** Contracts, a domain kernel, tests bound to the feature, and a runtime for persistence, messaging and tracing. Every stable stack is built and tested in CI.
- **Govern.** An agent firewall for MCP clients, IDE agents and the CLI's own agent loops. Risk scoring of every change, traceability from requirement to code to tests, and a local audit trail.
- **Verify.** Spec-to-code convergence, contract drift checks (a feature changed alone, a route the running service no longer serves), and agent repair loops sandboxed in a container by default, with stable exit codes and `--json` for CI.

Adding it to an existing code base? Start with [docs/ADOPTION.md](docs/ADOPTION.md); for the organization-wide rollout, [docs/ENTERPRISE.md](docs/ENTERPRISE.md). Upgrading a generated project? See [docs/MIGRATION-3.2.md](docs/MIGRATION-3.2.md), which covers every path from 2.x.

## Installation

Requires Node.js 22.12 or later.

```bash
npm install -g gherkin-ai     # installs the `gherkin-ai` and `ghk` commands
npx -y gherkin-ai@3 --help    # or run without installing
```

## Quick start

```bash
ghk init --yes -l typescript -f nestjs          # project configuration (gherkin-ai.config.json)
ghk create                                      # write a feature interactively, or:
ghk speckit import                              # convert Spec Kit specs/NNN-*/spec.md into features
ghk lint --threshold 80                         # specification quality gate (exit 4 below threshold)
ghk generate -f features/orders.feature         # contracts, domain kernel, tests, runtime
ghk implement -f features/orders.feature        # implementation prompt and context for your agent
ghk converge --threshold 80                     # spec-to-code convergence (exit 7 below threshold)
ghk risk --base origin/main --fail-on HIGH      # delivery risk of the change (exit 4 at HIGH or above)
ghk graph --trace OrderPlaced                   # requirement -> code -> tests
```

Connect your coding agent:

```bash
ghk mcp install                                 # least-privilege MCP server for Cursor, Claude Desktop and others
ghk firewall check --exec "npm test && git push"  # what an agent may write, run, reach and read
```

## Capabilities

| Capability | Commands | Status |
|---|---|---|
| Specification lint, semantic model, validation | `lint`, `validate`, `create`, `export` | Stable |
| Industry profiles: reference standards as lint rules, constraints and agent guidance | `industry`, `init --industry` | Stable |
| Code generation for the supported stacks | `init`, `generate`, `add`, `upgrade` | Stable |
| Runtime kernel: PostgreSQL, outbox/inbox over RabbitMQ, Pub/Sub, Service Bus or Kafka, sagas, OpenTelemetry | generated with each backend | Stable |
| Production image and deployment: Dockerfile, Terraform (AWS, GCP, Azure), Helm | generated with each backend; `deploy` in the configuration | Stable |
| Spec-to-code convergence and drift | `converge`, `diff`, `impact` | Stable |
| Agent prompts and context packages | `implement`, `context`, `skill` | Stable |
| MCP server (read-only by default) | `mcp` | Stable |
| Agent firewall (MCP, CLI agent loops, Claude Code hook) | `firewall` | Stable |
| Configuration layers, organization locks, provider policy | `config`, `login`, `auth` | Stable |
| Audit trail and SIEM export | `audit`, `audit export` | Stable |
| Delivery risk scoring | `risk`, `quality` | Stable |
| Traceability graph | `graph` | Stable |
| GitHub Spec Kit import / export | `speckit` | Stable |
| A/B benchmark of an agent with and without gherkin-ai | `bench` | Stable |
| Web Studio (local UI) | `web` | Stable |
| LLM repair loops | `verify --auto-fix`, `autopilot` | Experimental |

- **Stable:** covered by tests and by the golden builds, with the CLI contract (exit codes, `--json`) kept across 3.x.
- **Beta:** complete and tested; output formats may still change in a minor release. No feature is in beta in 3.2.
- **Experimental:** use with human review only.

The LLM repair loops write `.patch` proposals by default. `--apply` is refused in CI and on protected branches unless explicitly allowed, and every file goes through the agent firewall.

## Supported stacks

Every stack below is built and tested in CI. A sample project is generated, built in the stack's official Docker image, and its generated test suite is run. For backends, the runtime integration suite also runs against real PostgreSQL and the stack's broker: RabbitMQ, the Pub/Sub and Service Bus emulators, or Kafka. Then the production image is started, its health probes must answer, and its traces must reach an OpenTelemetry collector.

| Kind | Stacks |
|---|---|
| Backends | TypeScript (NestJS 11 or 12, Express 5; Prisma 6 or 7), C# (ASP.NET Core 8), Java and Kotlin (Spring Boot 4, Quarkus 3.40 LTS), Python (FastAPI, Django), Go (chi), PHP (Laravel 13), Ruby (Rails 8), Elixir (Phoenix), Rust (Axum) |
| Frontends and apps | React 19, Vue 3, Angular 22, Next.js 16, React Native (Expo 57), Flutter, Phoenix LiveView |
| Brokers (runtime kernel) | RabbitMQ (every backend; Amazon MQ, CloudAMQP), Google Cloud Pub/Sub (every backend), Azure Service Bus and Apache Kafka (JVM, TypeScript, .NET, Python, Go) |
| Contracts and infrastructure | gRPC (Protobuf, buf-linted), GraphQL SDL, Terraform (AWS, GCP, Azure) and Helm (validated and linted), CI/CD for GitHub Actions, GitLab CI and Azure Pipelines, AWS CDK (opt-in, synthesized in CI) |

Other combinations generate contracts and prompts only and are reported as experimental. `ghk stacks` lists the current matrix. The evidence behind these claims, and how to reproduce it, is in [docs/EVALUATION_REPORT.md](docs/EVALUATION_REPORT.md).

## Industry standards

A project can opt in to the reference standards of its industry with `industry.id` (`ghk init --industry banking`, or `ghk industry apply banking` in an existing project). The standards become lint rules on every specification, constraints in the semantic model and the contracts (`x-industry`), rules in every agent prompt, and human-approval paths in the agent firewall.

| Industry | Reference standards |
|---|---|
| Banking & Financial Services | BIAN Service Landscape 12.0, ISO 20022 |
| Telecommunications | TM Forum Open Digital Architecture, TM Forum Open APIs, SID |
| Manufacturing & Energy | RAMI 4.0, IDTA Asset Administration Shell, ISA-95, Eclipse Sparkplug B |
| Healthcare | HL7 FHIR R4 / R5, openEHR |
| Supply Chain & Logistics | ASCM SCOR Digital Standard, GS1 |
| Insurance | ACORD Reference Architecture, ACORD data standards |
| Aviation & Travel | IATA NDC, IATA ONE Order |
| Automotive & Software-Defined Vehicles | AUTOSAR Adaptive, ISO 26262, ISO/SAE 21434 |

Each profile lists its rules, vocabulary, recommended architecture, compliance reminders and a sample feature in [docs/INDUSTRIES.md](docs/INDUSTRIES.md). The compliance items are engineering guidance, not certification.

## Automation contract

| Exit code | Meaning |
|---|---|
| 0 | success |
| 2 | usage error |
| 3 | invalid configuration |
| 4 | quality gate failed (`lint`, `validate`, `risk --fail-on`, …) |
| 5 | denied by policy (firewall, organization allow-lists, protected branch) |
| 6 | LLM provider or network failure |
| 7 | specification drift |

With `--json`, stdout carries exactly one JSON document and diagnostics go to stderr. Details: [docs/ENTERPRISE.md#5-automation-contract-exit-codes-and---json](docs/ENTERPRISE.md#5-automation-contract-exit-codes-and---json).

## Known limitations

- **Semantic model.** It is extracted from Gherkin with deterministic rules. Unusual phrasing can produce generic command names. `ghk lint` reports specifications that are too vague to model. The `@aggregate:Name`, `@command:Name` and `@event:Name` tags set the names explicitly in any Gherkin dialect, and `ghk lint --explain-ir` shows where every generated name comes from.
- **Generated runtime.** It is a verified starting point, not a framework. The runtime kernel covers one aggregate per feature, on PostgreSQL, with RabbitMQ, Pub/Sub, Service Bus or Kafka. Other databases generate contracts and configuration only; MySQL and MongoDB persistence are planned for 3.3.
- **Industry profiles.** Their rules check the specification, not the code, and their compliance items are engineering guidance, not certification.
- **Traceability graph.** It links code by symbol names. Code that does not use the domain names from the specification is not linked.
- **Risk scores.** They are heuristics with documented weights and evidence. Calibrate the approval threshold (`policy.risk`) to your organization.
- **LLM repair loops.** They depend on the model and can fail to converge. They are experimental and always need review.
- **Benchmarks.** `ghk bench` measures your agent on your tasks. gherkin-ai does not publish model-quality claims of its own.

## Documentation

- [Usage guide](docs/USAGE_GUIDE.md): the delivery flow, from specification to merge
- [Adopting gherkin-ai in an existing project](docs/ADOPTION.md)
- [Enterprise guide](docs/ENTERPRISE.md): configuration and policy, providers, network, credentials, firewall, risk, MCP, audit, CI
- [Industry profiles](docs/INDUSTRIES.md)
- [Commands](docs/COMMANDS.md)
- [Runtime kernel](docs/RUNTIME-KERNEL.md)
- [Deployment](docs/DEPLOYMENT.md): production image, brokers per cloud, Terraform, Helm, CI/CD
- [Verification evidence](docs/EVALUATION_REPORT.md)
- [MCP guide](docs/MCP_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- Migration: [to 3.2](docs/MIGRATION-3.2.md) (every path from 2.x), [to 3.1](docs/MIGRATION-3.1.md), [to 3.0](docs/MIGRATION-3.0.md)
- [Changelog](CHANGELOG.md)

## Support and security

See [SUPPORT.md](SUPPORT.md) for the support and versioning policy and for how to get help. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Published on npm by the [fenner](https://www.npmjs.com/org/fenner) organization. Product page: <https://fennereduardo.com/pages/gherkin-ai-agent-architect>.
