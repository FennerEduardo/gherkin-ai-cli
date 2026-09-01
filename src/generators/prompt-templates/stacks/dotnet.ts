import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const dotnetTemplate: PromptTemplate = {
  name: 'C# .NET',
  match: (config) => config.stack.language === 'csharp' || config.stack.framework === 'dotnet-aspnetcore',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (C#)', `Implement domain entities and ports in C# 10+.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: C#\n- Do not use Entity Framework [Table] or [Column] data annotations in the pure domain core.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure C# classes/records for Entities/Aggregates\n2. Interfaces for Domain Events\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (.NET)', 'Implement ASP.NET Core Controllers, MediatR Handlers, and EF Core repositories.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ASP.NET Core\n- ORM: Entity Framework Core\n- Validation: FluentValidation\n- Auth: ASP.NET Core Identity\n` +
      `\n📌 Implementation Rules:\n- Use MediatR for CQRS if configured.\n- Use FluentValidation rules instead of Data Annotations.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (xUnit)', `Implement automated tests using xUnit, Moq, and FluentAssertions.`, ctx) +
      `\n📌 Fixture Reference:\n- Use WebApplicationFactory for integration tests.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests with Moq.\n2. Integration tests pointing to an in-memory or test database.\n`;
  }
};
