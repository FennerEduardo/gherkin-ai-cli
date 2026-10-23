# Usage guide

A typical delivery flow with gherkin-ai and a coding agent. Every command is described in [COMMANDS.md](COMMANDS.md). For an existing code base, follow [ADOPTION.md](ADOPTION.md) first; to upgrade a generated project, [MIGRATION-3.2.md](MIGRATION-3.2.md).

## 1. Set up the project

```bash
npm install --save-dev gherkin-ai     # or install it globally
ghk init --yes -l java -f spring-boot --frontendFramework vue
ghk mcp install                       # optional: expose read-only tools to your agent
```

Commit `gherkin-ai.config.json`. Organization-wide settings belong in the organization layer ([ENTERPRISE.md §1](ENTERPRISE.md#1-configuration-layers-and-organization-policy)).

If the service belongs to one of the supported industries (banking, telecom, manufacturing, health, supply chain, insurance, aviation, automotive), opt in to its reference standards with `ghk init --industry <id>` or `ghk industry apply <id>`. Lint then checks the industry rules, and the agents get the standards in every prompt ([INDUSTRIES.md](INDUSTRIES.md)).

## 2. Specify

Write features with `ghk create`, by hand, or import them from Spec Kit with `ghk speckit import`. Then check their quality:

```bash
ghk lint --threshold 80
ghk validate -f features/orders.feature
```

Tag a feature with `@aggregate:Order` to choose the type name, and with `@critical` to raise its business criticality in risk scoring.

Commands and events are inferred from the steps. That works best in English; in other dialects the generated API falls back to one generic command (`process_<aggregate>`), and lint rule GHK016 reports it. Declare them explicitly with tags. Explicit tags win in every dialect, both in the semantic model and in the generated code.

```gherkin
@aggregate:Order @command:PlaceOrder @event:OrderPlaced
Feature: Order placement

  @command:CancelOrder
  Scenario: Cancel a pending order
```

- **Feature tags.** `@command` and `@event` declare the service's commands and events; the n-th event belongs to the n-th command.
- **Scenario tags.** A `@command` tag on a scenario links that scenario to the command.

`ghk lint --explain-ir` shows the aggregate, the HTTP route, the commands and the events the generator will use, where each name comes from (tag, step identifier, English verb heuristic or default), and the tags that would make it explicit.

## 3. Generate and implement

```bash
ghk generate -f features/orders.feature     # contracts, domain kernel, tests, runtime
ghk implement -f features/orders.feature    # prompt and context package for the agent
```

The generated project builds and its tests pass as generated. Its BDD steps are *pending*: the agent, or a developer, implements them. Limit what the agent may change to the feature's scope:

```bash
ghk graph --scope features/orders.feature
ghk firewall policy --feature features/orders.feature
```

## 4. Verify before merging

```bash
ghk verify                                  # project tests (add --docker for the sandbox)
ghk converge --threshold 80                 # does the code still match the specification?
ghk risk --base origin/main --fail-on HIGH  # how risky is this change?
ghk graph                                   # which commands and events lack code or tests
```

In CI, use `--json` and rely on the exit codes. The recommended pipeline is in [ENTERPRISE.md §12](ENTERPRISE.md#12-ci-integration).

## 5. Keep an audit trail

```bash
ghk audit                        # feature inventory: who generated what, with spec hashes
ghk audit export --since 30d     # security audit trail (LLM calls, MCP calls, firewall decisions)
```

## 6. Measure the value

Run `ghk bench` on a representative task to compare your agent with and without the specification and generated contracts ([ENTERPRISE.md §18](ENTERPRISE.md#18-measuring-value-ab-benchmark)).
