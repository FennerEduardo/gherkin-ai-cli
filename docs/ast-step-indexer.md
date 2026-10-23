# Step definitions dictionary

LLMs tend to invent new Gherkin steps (`Given that the user enters data`) instead of reusing the step definitions a test suite already has (`Given I navigate to the login page`). The result is duplicated step code, or steps nobody implements.

gherkin-ai indexes the existing step definitions before it writes the agent prompts, and requires the agents to reuse them.

## What is indexed

| Language | How | Where |
|---|---|---|
| TypeScript, JavaScript (cucumber-js, Cypress, Playwright) | AST, with `ts-morph`: string, template and regular-expression arguments of `Given`, `When`, `Then` (also `Dado`, `Cuando`, `Entonces`) | `cypress/support/**`, `e2e/steps/**`, `tests/steps/**`, `features/step_definitions/**`, `src/**/*.step(s).ts` |
| Java, Kotlin | annotations: `@Given("…")`, `@When`, `@Then`, `@And`, `@But` | every `.java` and `.kt` file |
| Python (behave, pytest-bdd) | decorators: `@given("…")`, `@when`, `@then`, `@step` | every `.py` file |
| C# (Reqnroll, SpecFlow) | attributes: `[Given("…")]`, `[When]`, `[Then]` and their `Async` variants | every `.cs` file |
| Ruby (Cucumber) | `Given(/…/) do` | every `.rb` file |

`node_modules`, `target`, `build`, `.git`, `venv` and `__pycache__` are skipped.

**Generated skeletons are left out.** `ghk generate` writes pending BDD steps for each feature. A step file whose checksum still matches what gherkin-ai wrote (`.ghe/inventory.json`) is not existing work, so it is not listed. Once someone edits it, it is listed again. Regenerating therefore writes the same prompts as a clean generation.

## What the agent sees

The steps go into `prompts/qa-agent.md` (and the AI engineer prompt, when there is one), with their project-relative path:

```markdown
## [MANDATORY] Step Definitions Dictionary
You MUST reuse the following existing Step Definitions whenever possible instead of inventing new ones:

- `Given I navigate to the {string} page` (found in cypress/support/steps.ts)
```

Each annotation is listed once.
