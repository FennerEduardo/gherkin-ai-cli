/* ==========================================================================
   gherkin-ai-cli - C# .NET & SpecFlow Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateCsharpDotnetPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') + 'StepDefinitions';

  const stepDefCode = `// SpecFlow Step Definitions for ${parsed.featureName}
using System;
using TechTalk.SpecFlow;

namespace Tests.Steps
{
    [Binding]
    public class ${className}
    {
${parsed.scenarios.map(sc => `
        // Scenario: ${sc.name}
${sc.steps.map(st => `
        [${st.keyword.trim()}("${st.text.replace(/"/g, '""')}")]
        public void ${st.keyword.trim()}${st.text.replace(/[^a-zA-Z0-9]/g, '')}()
        {
            // TODO: Implement step
        }
`).join('')}
`).join('')}
    }
}
`;

  return [
    {
      filename: `${className}.cs`,
      content: stepDefCode
    }
  ];
}
