/* ==========================================================================
   gherkin-ai-cli - PHP Laravel & Behat Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generatePhpLaravelPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '') + 'Context';

  const stepDefCode = `<?php
// Behat Context for ${parsed.featureName}

namespace Tests\\Behat;

use Behat\\Behat\\Context\\Context;
use Tests\\TestCase;

class ${className} extends TestCase implements Context
{
    /**
     * Initializes context.
     * Every scenario gets its own context instance.
     */
    public function __construct()
    {
        parent::setUp();
    }

${parsed.scenarios.map(sc => `
    // Scenario: ${sc.name}
${sc.steps.map(st => `
    /**
     * @${st.keyword.trim()} ${st.text.replace(/'/g, "\\'")}
     */
    public function step${st.text.replace(/[^a-zA-Z0-9]/g, '')}()
    {
        // TODO: Implement step
    }
`).join('')}
`).join('')}
}
`;

  return [
    {
      filename: `${className}.php`,
      content: stepDefCode
    }
  ];
}
