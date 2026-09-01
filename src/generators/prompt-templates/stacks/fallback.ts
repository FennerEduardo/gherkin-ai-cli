import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const fallbackTemplate: PromptTemplate = {
  name: 'Generic Fallback',
  match: () => true, // Always matches as fallback
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    const extraPatterns = ctx.config.designPatterns?.length ? `\n\n🧩 Additional Design Patterns:\n${ctx.config.designPatterns.map((p: string) => `- ${p}`).join('\n')}` : '';
    return buildCommonHeader('DOMAIN ARCHITECT AGENT', `Implement domain entities, value objects, aggregates, and domain event ports according to ${ctx.arch.name}.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map((p: string) => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: ${ctx.config.stack.language}\n- Layer Boundary Rule: Core domain must NEVER import framework libraries.\n- Prohibited Core Imports: ${ctx.arch.prohibitedImports.join(', ')}${extraPatterns}\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure Entities & Aggregates\n2. Domain Event Interfaces & Repository Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT', 'Implement Use Cases, Handlers, Controllers, DTOs, and ORM Persistence.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n- ORM / Persistence: ${ctx.config.stack.orm}\n- Validation: ${ctx.config.stack.validation}\n- Auth: ${ctx.config.stack.auth}\n- Messaging: ${ctx.config.stack.messaging || 'None'}\n` +
      `\n📌 Contract References:\n- Read interfaces from ./contracts.ts\n- Use designated validation schemas\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA & AUTOMATION ENGINEER AGENT', `Implement automated tests using ${ctx.config.stack.testing}.`, ctx) +
      `\n📌 Fixture Reference:\n- Use test fixture setup from ./fixtures.ts\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for Domain Core.\n2. Integration tests for Repository adapters and API controllers.\n3. Automated BDD step definitions matching Gherkin scenarios.\n`;
  }
};
