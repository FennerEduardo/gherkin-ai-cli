/* ==========================================================================
   gherkin-ai-cli - Ruby on Rails (RSpec/Turnip) Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateRubyRailsPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const stepDefCode = `# Turnip (RSpec) Step Definitions for ${parsed.featureName}

${parsed.scenarios.map(sc => `
# Scenario: ${sc.name}
${sc.steps.map(st => `
step '${st.text.replace(/'/g, "\\'")}' do
  # TODO: Implement step
  pending "Not implemented yet"
end
`).join('')}
`).join('')}
`;

  return [
    {
      filename: `spec/steps/${moduleName}_steps.rb`,
      content: stepDefCode
    }
  ];
}
