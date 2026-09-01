import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const nestjsTemplate: PromptTemplate = {
  name: 'NestJS TypeScript',
  match: (config) => config.stack.framework === 'nestjs' || config.stack.framework === 'express',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (TypeScript/NestJS)', `Implement domain entities and ports in strict TypeScript.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: TypeScript\n- Avoid NestJS decorators (@Injectable, etc.) in the pure domain core.\n- Prohibited Core Imports: ${ctx.arch.prohibitedImports.join(', ')}\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure TS Entities/Aggregates\n2. Interfaces for Domain Events\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (NestJS)', 'Implement NestJS Controllers, Services, Modules, and Prisma/TypeORM repositories.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: NestJS\n- ORM: ${ctx.config.stack.orm} (Use injected services)\n- Validation: ${ctx.config.stack.validation} (Pipes & DTOs)\n- Auth: ${ctx.config.stack.auth} (Guards/Strategies)\n` +
      `\n📌 Implementation Rules:\n- Read interfaces from ./contracts.ts\n- Create standard NestJS @Module() and @Controller() structures.\n- Map domain interfaces to ORM models.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Jest/Supertest)', `Implement automated tests using Jest and Supertest.`, ctx) +
      `\n📌 Fixture Reference:\n- Use test fixtures from ./fixtures.ts\n- Setup NestJS TestingModule.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for Domain and Services.\n2. e2e API tests using Supertest.\n`;
  }
};
