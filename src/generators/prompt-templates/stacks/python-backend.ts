import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const pythonBackendTemplate: PromptTemplate = {
  name: 'Python Backend (Django/FastAPI/Flask)',
  match: (config) => config.stack.language === 'python',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Python)', `Implement pure domain logic in Python.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Python 3.10+\n- Do not import framework-specific packages (like Django models or FastAPI routers) in the pure domain core.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure Python dataclasses or Pydantic models for Entities\n2. Abstract Base Classes (ABC) for Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`BACKEND DEVELOPER AGENT (${ctx.config.stack.framework})`, 'Implement API endpoints, views, and ORM models.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n- ORM: ${ctx.config.stack.orm}\n- Validation: ${ctx.config.stack.validation}\n` +
      `\n📌 Implementation Rules:\n- Map domain models to ORM classes.\n- Use dependency injection where appropriate.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`QA AGENT (${ctx.config.stack.testing})`, `Implement automated tests using Pytest or Unittest.`, ctx) +
      `\n📌 Fixture Reference:\n- Use pytest fixtures.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests with mocked ports.\n2. Integration tests for API endpoints.\n`;
  },
  generateAiAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('AI ENGINEER AGENT (Python)', 'Implement LLM chains, embeddings, and RAG architectures.', ctx) +
      `\n🛠️ Target AI Tech: ${ctx.config.stack.aiEngine}\n` +
      `\n📌 Implementation Rules:\n- Optimize vector database queries.\n- Use proper prompt templates and chunking strategies.\n\n` +
      buildScenarios(ctx);
  }
};
