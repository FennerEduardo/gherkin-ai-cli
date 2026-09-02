# AST Step Definitions Indexer

A common challenge when integrating AI into Behavior-Driven Development (BDD) is **AI Hallucination**: Large Language Models (LLMs) tend to invent generic Gherkin steps (e.g., `Given that the user enters data`) rather than reusing the exact Step Definitions already implemented in your test automation framework (e.g., `Given I navigate to login`).

This lack of alignment forces QA engineers to manually rewrite generated steps or duplicate test executor code.

## How `gherkin-ai` Solves This

`gherkin-ai` incorporates an advanced **AST (Abstract Syntax Tree) Step Indexer** powered by `ts-morph`.

Instead of relying on the LLM's raw creativity, the CLI performs static code analysis on your project workspace before generating any AI prompts.

### 1. Static Analysis
The indexer scans common E2E directories in your project:
- `cypress/support/**/*.ts`
- `e2e/steps/**/*.ts`
- `features/step_definitions/**/*.ts`

It extracts the string literals and regular expressions defined inside `Given`, `When`, and `Then` function calls.

### 2. Prompt Injection (The Dictionary)
All extracted steps are compiled into a mandatory "Step Definitions Dictionary" and injected into the System Prompt for the `qa-agent` and `ai-engineer` agents.

The prompt explicitly enforces:
> *You MUST reuse the following existing Step Definitions whenever possible instead of inventing new ones.*

### Example

**Existing Cypress Step:**
```typescript
Given('I navigate to the {string} page', (pageName: string) => {
    cy.visit(`/${pageName}`);
});
```

**What the AI Agent sees:**
```markdown
## [MANDATORY] Step Definitions Dictionary
You MUST reuse the following existing Step Definitions whenever possible instead of inventing new ones:
- `Given I navigate to the {string} page` (found in cypress/support/steps.ts)
```

## Phased Language Support

Currently, the AST Indexer natively supports TypeScript and JavaScript ecosystems (Cypress, Playwright, Cucumber-JS) via `ts-morph`. 

A secondary `RegexStepParser` acts as a fallback foundation designed to support Python (Behave), Java (Cucumber-JVM), and other languages in future phases.
