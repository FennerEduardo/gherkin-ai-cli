/* ==========================================================================
   gherkin-ai-cli - Executable AI Agent Prompt Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { getArchRule } from '../core/arch-rules';
import { getStackSpec } from '../core/stack-specs';

export function generatePrompts(parsed: ParsedFeature, config: GherkinAIConfig): Record<string, string> {
  const arch = getArchRule(config.architecture);
  const spec = getStackSpec(config.stack);

  const domainPrompt = `🤖 ROLE: DOMAIN ARCHITECT AGENT
Objective: Implement domain entities, value objects, aggregates, and domain event ports according to ${arch.name}.

📌 Feature Specification: ${parsed.featureName}
${parsed.descriptionLines.map(l => `> ${l}`).join('\n')}

🏗️ Strict Architectural Patterns:
${arch.patterns.map(p => `- ${p}`).join('\n')}

🛠️ Technical Rails:
- Language: ${config.stack.language} (ES2022 / Strict TypeScript)
- Layer Boundary Rule: Core domain must NEVER import framework libraries.
- Prohibited Core Imports: ${arch.prohibitedImports.join(', ')}

📂 Folder Structure Target:
${arch.folderStructure}

🎯 Scenarios to Fulfill:
${parsed.scenarios.map((sc, i) => `${i + 1}. "${sc.name}"`).join('\n')}

Must Output:
1. Pure TypeScript Entities & Aggregates in src/domain/
2. Domain Event Interfaces & Repository Ports in src/domain/ports/
`;

  const backendPrompt = `🤖 ROLE: BACKEND DEVELOPER AGENT
Objective: Implement Use Cases, Handlers, Controllers, DTOs, and ORM Persistence.

🛠️ Target Technology Stack & Packages:
- Framework: ${config.stack.framework} (${spec.frameworkVersion})
- ORM / Persistence: ${config.stack.orm} (${spec.ormPackage})
- Validation: ${config.stack.validation} (${spec.validationPackage})
- Auth & Hash: ${config.stack.auth} (${spec.authPackages.join(', ')}, bcrypt cost ${spec.bcryptCostFactor})
- Messaging: ${config.stack.messaging} (${spec.messagingPackage})

📌 Contract References:
- Read interfaces from ./contracts.ts
- Use Zod schemas for input validation

🎯 Execution Tasks:
1. Implement Use Case handlers matching command schemas.
2. Implement Repository persistence adapters for ${config.stack.database}.
3. Create API controller endpoints for each scenario:
${parsed.scenarios.map(sc => `   - Endpoint for: "${sc.name}"`).join('\n')}
`;

  const qaPrompt = `🤖 ROLE: QA & AUTOMATION ENGINEER AGENT
Objective: Implement automated tests (Unit, Integration, BDD) using ${config.stack.testing} (${spec.testPackages.join(', ')}).

📌 Fixture Reference:
- Use test fixture setup from ./fixtures.ts

🎯 Testing Deliverables:
1. Unit tests for Domain Core with >= 85% branch coverage.
2. Integration tests for Repository adapters and API controllers.
3. Automated BDD step definitions matching Gherkin scenarios:
${parsed.scenarios.map(sc => `   * ${sc.name}`).join('\n')}
`;

  return {
    'domain-agent.md': domainPrompt,
    'backend-agent.md': backendPrompt,
    'qa-agent.md': qaPrompt
  };
}
