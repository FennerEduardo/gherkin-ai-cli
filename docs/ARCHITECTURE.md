# Architecture

gherkin-ai is a Node.js (TypeScript) CLI. It is deterministic by default: only `verify --auto-fix`, `autopilot` and the optional LLM-backed suggestions call a model. Everything else — parsing, generation, verification, risk, graph and firewall decisions — is computed from files, specifications and git.

```text
 requirements ──► .feature files ◄── Spec Kit (speckit import/export)
                      │
                      ▼
   Gherkin parser (@cucumber/gherkin) ─► semantic IR ─► lint / validate
   commands · events · endpoints · states · invariants · policies
                      │
       ┌──────────────┼──────────────────────────┬─────────────────────────┐
       ▼              ▼                          ▼                         ▼
  generators     agent context            verification              governance
  (20+ stacks)   (implement, MCP)         (converge, diff,          (firewall, risk,
  domain kernel                            verify --docker)          graph, audit)
  runtime kernel                                 ▲                         │
       │                                         │                         │
       └────────── generated project ────────────┴──── agents (MCP, IDE hooks, CLI loops)
```

## Main modules

| Area | Location | Notes |
|---|---|---|
| CLI entry, exit codes, `--json` | `src/index.ts`, `src/cli/` (one module per command group of [COMMANDS.md](COMMANDS.md)), `src/core/errors.ts`, `src/utils/output.ts` | Commands are loaded lazily. One error handler maps errors to exit codes. |
| Configuration | `src/core/config/` | zod schema → JSON Schema. Layers: organization, user, project, environment, with `locked` keys. |
| Parsing and IR | `src/core/gherkin-parser.ts`, `src/core/ir/` (extractors; `ir-builder.ts` is the entry point), `src/core/semantic-ir.ts` | Official Cucumber parser with every Gherkin dialect. The IR elements carry source locations. The IR is a pure function of the feature and is cached in memory, and on disk in `.ghe/cache/ir` for `graph` and the kernel refresh. |
| Industry profiles | `src/core/profiles/industries/` | One data file per industry (standards, glossary, architecture, compliance, approval paths, agent rules) and its lint rules. See [INDUSTRIES.md](INDUSTRIES.md). |
| Generators | `src/generators/` | One preset per stack, built on a shared domain model (`kernel/domain-model.ts`). The runtime kernel per language lives in `kernel/runtime/`, the application layer in `kernel/app/`, the production image, Terraform and Helm in `deploy/`, the CI/CD pipelines in `cicd/`, and the toolchain registry in `toolchains.ts`. |
| Verification | `src/core/convergence-engine.ts`, `src/commands/verify.ts`, `src/core/execution-sandbox.ts` | Convergence compares the specification with the generated contracts. The Docker sandbox runs without network, with resource limits and a read-only root filesystem. |
| Governance | `src/core/governance/` (firewall, write guard, spec hashes), `src/core/risk-engine.ts`, `src/core/graph/` | The firewall is the single decision point for agent actions. Risk and the graph are deterministic. |
| LLM layer | `src/core/llm/` | One adapter per provider, a single retry layer, timeouts, budgets, a proxy-aware dispatcher and redaction before sending. |
| MCP server | `src/mcp/` | Official SDK. Tools are grouped by safety level and run in-process. |
| Audit and telemetry | `src/core/telemetry.ts` | Local JSONL only, redacted, with an execution id per run. |
| Interop and benchmark | `src/core/interop/speckit.ts`, `src/core/bench/` | Spec Kit conversion and the A/B harness. |

## How generated code is verified

`scripts/golden-build.js` checks every stack in the registry (`scripts/golden-stacks.js`):

1. generates a sample project from `scripts/golden-feature.feature` (backends and frontends get a second feature in the same service);
2. builds it in the stack's official image;
3. runs its unit, contract and BDD tests;
4. for backends, runs the runtime integration suite against PostgreSQL 17 and the stack's broker: RabbitMQ 4, the Pub/Sub or Service Bus emulator, or Kafka (`src/core/services.ts`, shared with `ghk verify --services`);
5. for backends, builds the production image, starts it next to an OpenTelemetry collector, and requires the health probes, one authenticated command and its spans.

Deployment and CI goldens run Terraform (`validate`, `fmt -check`), Helm (`lint --strict`, `template`), actionlint and the official pipeline schemas instead. CI runs one job per stack. See [EVALUATION_REPORT.md](EVALUATION_REPORT.md) for the evidence, and [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md) for the runtime contract.
