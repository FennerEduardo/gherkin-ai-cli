# gherkin-ai

[![npm version](https://img.shields.io/npm/v/gherkin-ai.svg)](https://www.npmjs.com/package/gherkin-ai)
[![CI](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FennerEduardo/gherkin-ai-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Spec-driven verification and governance for AI-assisted software delivery.**

gherkin-ai turns requirements into executable Gherkin specifications and generates verified contracts and code for 20+ stacks. It gates changes on specification quality, drift and delivery risk, and controls what AI coding agents may change.

- **Specify.** Write or import (GitHub Spec Kit) `.feature` files, lint them, and build a semantic model of commands, events, endpoints, states and rules.
- **Generate.** Contracts, a domain kernel, tests bound to the feature, and a runtime for persistence, messaging and tracing. Every stable stack is built and tested in CI.
- **Govern.** An agent firewall for MCP clients, IDE agents and the CLI's own agent loops. Risk scoring of every change, traceability from requirement to code to tests, and a local audit trail.
- **Verify.** Spec-to-code convergence, drift detection and sandboxed test runs, with stable exit codes and `--json` for CI.

Rolling it out in a company? Start with [docs/ENTERPRISE.md](docs/ENTERPRISE.md). Upgrading from 2.x? See [docs/MIGRATION-3.0.md](docs/MIGRATION-3.0.md).

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
| Code generation for the supported stacks | `init`, `generate`, `add`, `upgrade` | Stable |
| Runtime kernel: PostgreSQL, RabbitMQ outbox/inbox, sagas, OpenTelemetry | generated with each backend | Stable |
| Spec-to-code convergence and drift | `converge`, `diff`, `impact` | Stable |
| Agent prompts and context packages | `implement`, `context`, `skill` | Stable |
| MCP server (read-only by default) | `mcp` | Stable |
| Agent firewall (MCP, CLI agent loops, Claude Code hook) | `firewall` | Stable |
| Configuration layers, organization locks, provider policy | `config`, `login`, `auth` | Stable |
| Audit trail and SIEM export | `audit`, `audit export` | Stable |
| Delivery risk scoring | `risk`, `quality` | Beta |
| Traceability graph | `graph` | Beta |
| GitHub Spec Kit import / export | `speckit` | Beta |
| A/B benchmark of an agent with and without gherkin-ai | `bench` | Beta |
| Web Studio (local UI) | `web` | Beta |
| LLM repair loops | `verify --auto-fix`, `autopilot` | Experimental |

- **Stable:** covered by tests and by the golden builds, with the CLI contract (exit codes, `--json`) kept across 3.x.
- **Beta:** complete and tested; output formats may still change in a minor release.
- **Experimental:** use with human review only.

The LLM repair loops write `.patch` proposals by default. `--apply` is refused in CI and on protected branches unless explicitly allowed, and every file goes through the agent firewall.

## Supported stacks

Every stack below is built and tested in CI. A sample project is generated, built in the stack's official Docker image, and its generated test suite is run. For backends, the runtime integration suite also runs against real PostgreSQL and RabbitMQ containers.

| Kind | Stacks |
|---|---|
| Backends | TypeScript (NestJS 11 or 12, Express 5; Prisma 6 or 7), C# (ASP.NET Core 8), Java and Kotlin (Spring Boot 3), Python (FastAPI, Django), Go (chi), PHP (Laravel 13), Ruby (Rails 8), Elixir (Phoenix), Rust (Axum) |
| Frontends and apps | React 19, Vue 3, Angular 22, Next.js 16, React Native (Expo 57), Flutter, Phoenix LiveView |
| Contracts and infrastructure | gRPC (Protobuf, buf-linted), GraphQL SDL, AWS CDK (opt-in, synthesized in CI) |

Other combinations generate contracts and prompts only and are reported as experimental. `ghk stacks` lists the current matrix. The evidence behind these claims, and how to reproduce it, is in [docs/EVALUATION_REPORT.md](docs/EVALUATION_REPORT.md).

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

- **Semantic model.** It is extracted from Gherkin with deterministic rules. Unusual phrasing can produce generic command names. `ghk lint` reports specifications that are too vague to model, and the `@aggregate:Name` tag sets the type name explicitly.
- **Generated runtime.** It is a verified starting point, not a framework. The runtime kernel covers one aggregate per feature with PostgreSQL and RabbitMQ. Other databases and brokers generate contracts and configuration only.
- **Traceability graph.** It links code by symbol names. Code that does not use the domain names from the specification is not linked.
- **Risk scores.** They are heuristics with documented weights and evidence. Calibrate the approval threshold (`policy.risk`) to your organization.
- **LLM repair loops.** They depend on the model and can fail to converge. They are experimental and always need review.
- **Benchmarks.** `ghk bench` measures your agent on your tasks. gherkin-ai does not publish model-quality claims of its own.

## Documentation

- [Enterprise guide](docs/ENTERPRISE.md): configuration and policy, providers, network, credentials, firewall, risk, MCP, audit, CI
- [Commands](docs/COMMANDS.md)
- [Runtime kernel](docs/RUNTIME-KERNEL.md)
- [Verification evidence](docs/EVALUATION_REPORT.md)
- [MCP guide](docs/MCP_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Migration to 3.0](docs/MIGRATION-3.0.md)
- [Changelog](CHANGELOG.md)

## Support and security

See [SUPPORT.md](SUPPORT.md) for the support and versioning policy and for how to get help. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
