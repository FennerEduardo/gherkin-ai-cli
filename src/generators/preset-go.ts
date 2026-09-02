/* ==========================================================================
   gherkin-ai-cli - Go & Godog Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateGoPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const packageName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const stepDefCode = `// Godog Step Definitions for ${parsed.featureName}
package ${packageName || 'bddtests'}

import (
    "context"
    "testing"
    "github.com/cucumber/godog"
)

${parsed.scenarios.map(sc => `
// Scenario: ${sc.name}
${sc.steps.map(st => `
func ${st.text.toLowerCase().replace(/[^a-z0-9]/g, '')}(ctx context.Context) (context.Context, error) {
    // TODO: Implement step
    return ctx, godog.ErrPending
}
`).join('')}
`).join('')}

func InitializeScenario(ctx *godog.ScenarioContext) {
${parsed.scenarios.map(sc => `
    // ${sc.name}
${sc.steps.map(st => `    ctx.Step(\`^${st.text.replace(/"/g, '\\"')}$\`, ${st.text.toLowerCase().replace(/[^a-z0-9]/g, '')})`).join('\n')}
`).join('\n')}
}

func TestFeatures(t *testing.T) {
    suite := godog.TestSuite{
        ScenarioInitializer: InitializeScenario,
        Options: &godog.Options{
            Format:   "pretty",
            Paths:    []string{"features"},
            TestingT: t,
        },
    }

    if suite.Run() != 0 {
        t.Fatal("non-zero status returned, failed to run feature tests")
    }
}
`;

  return [
    {
      filename: `${packageName}_test.go`,
      content: stepDefCode
    }
  ];
}
