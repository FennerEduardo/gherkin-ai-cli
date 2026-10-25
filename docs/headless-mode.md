# Headless mode

In CI (GitHub Actions, GitLab CI, Azure Pipelines) there is no terminal to answer prompts. Every command accepts `--yes` / `--non-interactive`, and never prompts with them; `GHK_NON_INTERACTIVE=true` does the same for a whole job. `--json` prints exactly one JSON document on stdout, and the exit codes are stable ([ENTERPRISE.md §5](ENTERPRISE.md#5-automation-contract-exit-codes-and---json)).

## Writing a feature without prompts

`ghk create` is interactive by default. `--headless --config <file>` builds the feature from a JSON description instead:

```bash
ghk create --headless --config specs/two-factor.json --output features/two_factor.feature
```

```json
{
  "featureName": "Two-factor authentication",
  "actor": "registered user",
  "action": "enable and verify a one-time code",
  "outcome": "my account is protected against unauthorized access",
  "scenarioName": "Enable and verify a one-time code",
  "steps": [
    { "keyword": "Given", "text": "the user has signed in" },
    { "keyword": "When", "text": "the user enters a valid 6-digit one-time code" },
    { "keyword": "Then", "text": "the session is verified" }
  ]
}
```

The feature is written in English Gherkin, whatever the CLI language (`ghk lang`) of the machine. For a Spanish feature, add `"language": "es"` and give the steps Spanish keywords (`Dado`, `Cuando`, `Entonces`); the file then starts with `# language: es`. Without `--output`, the file is written to `features/<feature_name>.feature`. With `"injectTarget": "<dir>"` (or `--target`), `ghk add` then writes the contracts and prompts into that directory.

## In a pipeline

Pin the version, so the generated output and the lint scores only change with a commit:

```yaml
name: Generate contracts
on:
  push:
    branches: [main]
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Feature from its JSON description
        run: npx --yes gherkin-ai@3.2.1 create --headless --config specs/two-factor.json --output features/two_factor.feature
      - name: Lint gate
        run: npx --yes gherkin-ai@3.2.1 lint -f features/two_factor.feature --threshold 80
      - name: Contracts, kernel, tests and prompts
        run: npx --yes gherkin-ai@3.2.1 generate -f features/two_factor.feature --yes
```

For the pull-request gates (lint, convergence and risk on the change), see [ADOPTION.md §4](ADOPTION.md#4-gate-pull-requests-then-tighten).
