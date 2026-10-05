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
| CLI entry, exit codes, `--json` | `src/index.ts`, `src/core/errors.ts`, `src/utils/output.ts` | Commands are loaded lazily. One error handler maps errors to exit codes. |
| Configuration | `src/core/config/` | zod schema → JSON Schema. Layers: organization, user, project, environment, with `locked` keys. |
| Parsing and IR | `src/core/gherkin-parser.ts`, `src/core/ir-builder.ts`, `src/core/semantic-ir.ts` | Official Cucumber parser with every Gherkin dialect. The IR elements carry source locations. |
| Generators | `src/generators/` | One preset per stack, built on a shared domain model (`kernel/domain-model.ts`). The runtime kernel per language lives in `kernel/runtime/` and the toolchain registry in `toolchains.ts`. |
| Verification | `src/core/convergence-engine.ts`, `src/commands/verify.ts`, `src/core/execution-sandbox.ts` | Convergence compares the specification with the generated contracts. The Docker sandbox runs without network, with resource limits and a read-only root filesystem. |
| Governance | `src/core/governance/` (firewall, write guard, spec hashes), `src/core/risk-engine.ts`, `src/core/graph/` | The firewall is the single decision point for agent actions. Risk and the graph are deterministic. |
| LLM layer | `src/core/llm/` | One adapter per provider, a single retry layer, timeouts, budgets, a proxy-aware dispatcher and redaction before sending. |
| MCP server | `src/mcp/` | Official SDK. Tools are grouped by safety level and run in-process. |
| Audit and telemetry | `src/core/telemetry.ts` | Local JSONL only, redacted, with an execution id per run. |
| Interop and benchmark | `src/core/interop/speckit.ts`, `src/core/bench/` | Spec Kit conversion and the A/B harness. |

## How generated code is verified

`scripts/golden-build.js` checks every stack in the registry (`scripts/golden-stacks.js`):

1. generates a sample project from `scripts/golden-feature.feature`;
2. builds it in the stack's official image;
3. runs its unit, contract and BDD tests;
4. for backends, runs the runtime integration suite against PostgreSQL 17 and RabbitMQ 4 containers (`scripts/golden-services.js`).

CI runs one job per stack. See [EVALUATION_REPORT.md](EVALUATION_REPORT.md) for the evidence, and [RUNTIME-KERNEL.md](RUNTIME-KERNEL.md) for the runtime contract.
