import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const rubyOnRailsTemplate: PromptTemplate = {
  name: 'Ruby on Rails',
  match: (config) => config.stack.framework === 'rails',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Ruby)', `Implement domain logic in pure Ruby objects (POROs).`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🏗️ Architectural Patterns:\n${ctx.arch.patterns.map(p => `- ${p}`).join('\n')}\n` +
      `\n🛠️ Technical Rails:\n- Language: Ruby\n- Keep pure domain separated from ActiveRecord.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Pure Ruby objects\n2. Service objects for business logic\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('BACKEND DEVELOPER AGENT (Rails)', 'Implement ActionControllers, ActiveRecords, and ActiveJobs.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Ruby on Rails\n- ORM: ActiveRecord\n- Validation: ActiveModel Validations\n- Auth: Devise\n` +
      `\n📌 Implementation Rules:\n- Follow Rails conventions (fat models, skinny controllers) or Service Objects if configured.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (RSpec)', `Implement automated tests using RSpec and FactoryBot.`, ctx) +
      `\n📌 Fixture Reference:\n- Use FactoryBot instead of traditional Rails fixtures if possible.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Model specs.\n2. Request specs for controllers.\n`;
  }
};
