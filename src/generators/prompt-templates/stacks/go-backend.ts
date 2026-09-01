import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const goBackendTemplate: PromptTemplate = {
  name: 'Go Backend (Gin/Fiber/Echo)',
  match: (config) => config.stack.language === 'go',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Go)', `Implement pure domain logic using Go structs and interfaces.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Go\n- Avoid using framework specific types (like *gin.Context or *fiber.Ctx) in the pure domain core.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Go Structs for Entities\n2. Go Interfaces for Repository and Service Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`BACKEND DEVELOPER AGENT (${ctx.config.stack.framework})`, 'Implement handlers, routing, and database repositories.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n- ORM: ${ctx.config.stack.orm}\n- Validation: ${ctx.config.stack.validation}\n` +
      `\n📌 Implementation Rules:\n- Map domain models to ORM structs.\n- Use context.Context for passing request scoping.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Go Testing)', `Implement automated tests using the testing package.`, ctx) +
      `\n📌 Fixture Reference:\n- Use httptest for API endpoints.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Table-driven unit tests for domain logic.\n2. Integration tests for handlers using httptest.\n`;
  }
};
