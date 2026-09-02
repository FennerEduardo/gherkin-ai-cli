/* ==========================================================================
   gherkin-ai-cli - Python FastAPI & pytest-bdd Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generatePythonFastApiPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_steps';

  const stepDefCode = `"""
pytest-bdd Step Definitions for ${parsed.featureName}
"""

from pytest_bdd import scenarios, given, when, then, parsers
from fastapi.testclient import TestClient
# from main import app

# scenarios('features/${parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}.feature')

# client = TestClient(app)

${parsed.scenarios.map(sc => `
# Scenario: ${sc.name}
${sc.steps.map(st => `
@${st.keyword.trim().toLowerCase()}('${st.text.replace(/'/g, "\\'")}')
def step_${st.text.toLowerCase().replace(/[^a-z0-9]/g, '_')}():
    # TODO: Implement step
    pass
`).join('')}
`).join('')}
`;

  return [
    {
      filename: `test_${moduleName}.py`,
      content: stepDefCode
    }
  ];
}
