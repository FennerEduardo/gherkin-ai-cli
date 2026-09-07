/* ==========================================================================
   gherkin-ai-cli - GitHub Actions CI/CD Workflow Generator
   ========================================================================== */

export function generateGitHubActionsWorkflow(options?: { specDir?: string; testCommand?: string }): string {
  const specDir = options?.specDir || 'features';
  const testCmd = options?.testCommand || 'npm test';

  return `name: gherkin-ai Continuous Integration & Quality Gate

on:
  push:
    branches: [ main, master, develop ]
  pull_request:
    branches: [ main, master, develop ]

jobs:
  gherkin-ai-verify:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js Environment
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install Project Dependencies
        run: npm ci || npm install

      - name: Install gherkin-ai CLI
        run: npm install -g gherkin-ai@latest

      - name: Run Specification Linter (ghk lint)
        run: ghk lint --spec-dir "${specDir}" --threshold 80 --json

      - name: Validate Layer Architecture Boundaries (ghk validate)
        run: ghk validate

      - name: Verify Specification Convergence (ghk converge)
        run: ghk converge --threshold 80

      - name: Run Test Suite
        run: ${testCmd}

      - name: Audit Dependency Security
        run: npm audit --audit-level=high
`;
}
