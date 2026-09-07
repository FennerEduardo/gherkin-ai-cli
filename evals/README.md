# Gherkin AI - Benchmark & Evals Suite

This directory contains the continuous evaluation framework for the Gherkin AI CLI. The suite is designed to prevent regressions in Semantic IR parsing accuracy, Convergence scoring, and Linter rules execution across diverse industry domains.

## Directory Structure

```text
evals/
├── runner.ts               # The main execution engine for evaluations
├── domains/
│   ├── ecommerce/          # E-commerce specific features
│   ├── banking/            # FinTech & Core Banking features
│   └── logistics/          # Supply Chain & Logistics features
```

Each domain has:
- `input/`: Contains `.feature`, `.yaml` (constitution), etc.
- `expected/`: Contains snapshots of the expected IR output and scores (`ir-snapshot.json`, `convergence-min.json`).

## Running Evaluations

Run the evaluation suite locally:

```bash
npm run eval
```

This will parse the inputs, generate the IR, and compare the outputs strictly against the snapshots in `expected/`. Any deviation in domain entity extraction (missing actors, commands, invalid state transitions) will fail the CI.
