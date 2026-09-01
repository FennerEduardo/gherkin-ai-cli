import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const laravelTemplate: PromptTemplate = {
  name: 'PHP Laravel',
  match: (config) => config.stack.framework === 'laravel' || config.stack.framework === 'symfony',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (PHP)', `Implement domain entities and ports in PHP 8+.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Strict Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: PHP\n- Keep pure domain separated from Laravel specific facades and Eloquent Models.\n- Prohibited Core Imports: Illuminate\\*, Eloquent\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure PHP Entities/Aggregates\n2. Interfaces for Domain Events\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (Laravel)', 'Implement Laravel Controllers, FormRequests, Jobs, and Eloquent repositories.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Laravel\n- ORM: Eloquent\n- Validation: FormRequests\n- Auth: Sanctum/Passport\n` +
      `\n📌 Implementation Rules:\n- Map domain interfaces to Eloquent Models.\n- Use FormRequests for validation, NOT the controller.\n- Use Jobs/Events for asynchronous tasks.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Pest/PHPUnit)', `Implement automated tests using Pest or PHPUnit.`, ctx) +
      `\n📌 Fixture Reference:\n- Use Laravel Factories and Seeders.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for Domain.\n2. Feature tests for API endpoints.\n`;
  }
};
