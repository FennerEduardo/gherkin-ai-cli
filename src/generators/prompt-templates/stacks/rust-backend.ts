import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const rustBackendTemplate: PromptTemplate = {
  name: 'Rust Backend (Axum/Actix)',
  match: (config) => config.stack.language === 'rust',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Rust)', `Implement domain logic using Rust structs and traits.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Rust\n- Use Results and Option enum for error and null handling.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Structs for Entities\n2. Traits for Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`BACKEND DEVELOPER AGENT (${ctx.config.stack.framework})`, 'Implement API routes, handlers, and ORM integrations.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n- ORM: ${ctx.config.stack.orm}\n` +
      `\n📌 Implementation Rules:\n- Implement From/Into traits for mapping DTOs to Domain models.\n- Handle asynchronous code safely.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Cargo Test)', `Implement automated tests.`, ctx) +
      `\n📌 Fixture Reference:\n- Place tests in the same file using #[cfg(test)] for unit tests, or in tests/ for integration.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for domain functions.\n2. Integration tests testing the API surface.\n`;
  }
};
