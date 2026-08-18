/* ==========================================================================
   gherkin-ai-cli - React, Playwright & MSW Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateReactPlaywrightPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const specName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.spec.ts';

  const playwrightCode = `import { test, expect } from '@playwright/test';

test.describe('${parsed.featureName}', () => {

${parsed.scenarios.map(sc => `
  test('${sc.name}', async ({ page }) => {
    // Accessibility-first Playwright Step Bindings
${sc.steps.map(st => `    // ${st.keyword} ${st.text}`).join('\n')}
  });
`).join('\n')}
});
`;

  return [
    {
      filename: specName,
      content: playwrightCode
    }
  ];
}
