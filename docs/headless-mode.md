# Headless CI/CD Mode

`gherkin-ai` is designed to be an enterprise automation framework. While the interactive CLI wizard (`ghk create`) is excellent for local development, CI/CD pipelines (like GitHub Actions, GitLab CI, Azure DevOps) operate in non-interactive (TTY-less) environments where standard input prompts cause execution to hang.

To solve this, `gherkin-ai` provides a robust **Headless Mode**.

## Usage

You can completely bypass the interactive `inquirer` prompts by combining the `--headless` flag with the `--config` flag.

```bash
ghk create --headless --config my-spec.json
```

### Configuration File (`my-spec.json`)

The `--config` file must contain the structured JSON representation of your feature.

```json
{
  "featureName": "Two Factor Authentication 2FA",
  "actor": "authenticated system user",
  "action": "enable and verify a two-factor OTP code",
  "outcome": "protect my account against unauthorized access",
  "scenarioName": "Enable and verify 2FA code successfully",
  "injectTarget": "./src/application/dtos",
  "steps": [
    {
      "keyword": "Given",
      "text": "the user has logged in successfully"
    },
    {
      "keyword": "When",
      "text": "they enter a valid 6-digit OTP code"
    },
    {
      "keyword": "Then",
      "text": "the system authenticates the session"
    }
  ]
}
```

## Integration with GitHub Actions

Here is an example of running `gherkin-ai` completely headlessly inside a GitHub Actions workflow:

```yaml
name: Generate Contracts

on:
  push:
    branches: [ "main" ]

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install gherkin-ai
        run: npm install -g gherkin-ai

      - name: Generate Feature Headlessly
        run: ghk create --headless --config specs/login-spec.json --output specs/login.feature
        
      - name: Generate Typings & Prompts
        run: ghk generate -f specs/login.feature
```
