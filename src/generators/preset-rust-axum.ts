/* ==========================================================================
   gherkin-ai-cli - Rust & cucumber-rs Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateRustAxumPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const stepDefCode = `// cucumber-rs Step Definitions for ${parsed.featureName}
use cucumber::{given, when, then, World};

#[derive(Debug, Default, World)]
pub struct AppWorld {
    // Add shared state here
}

${parsed.scenarios.map(sc => `
// Scenario: ${sc.name}
${sc.steps.map(st => `
#[${st.keyword.trim().toLowerCase()}(expr = "${st.text.replace(/"/g, '\\"')}")]
async fn step_${st.text.toLowerCase().replace(/[^a-z0-9]/g, '_')}(w: &mut AppWorld) {
    // TODO: Implement step
    todo!("Implement step: ${st.text.replace(/"/g, '\\"')}");
}
`).join('')}
`).join('')}

#[tokio::main]
async fn main() {
    AppWorld::run("features/${moduleName}.feature").await;
}
`;

  return [
    {
      filename: `tests/${moduleName}.rs`,
      content: stepDefCode
    }
  ];
}
