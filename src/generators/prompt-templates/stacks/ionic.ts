import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const ionicTemplate: PromptTemplate = {
  name: 'Ionic / Capacitor',
  match: (config) => config.stack.framework === 'ionic-angular',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (TypeScript)', `Implement front-end domain models and Capacitor plugin wrappers.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Language: TypeScript\n- Separate pure logic from Angular/Ionic specific components.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. TS Models\n2. Angular Services / Capacitor wrappers\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('UI DEVELOPER AGENT (Ionic/Angular)', 'Implement Ionic pages, components, and routing.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Ionic + Angular\n- UI: @ionic/angular components\n` +
      `\n📌 Implementation Rules:\n- Use Ionic lifecycle hooks instead of Angular ones where appropriate.\n- Implement responsive design for mobile and web.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Jasmine/Karma)', `Implement automated tests for Ionic components.`, ctx) +
      `\n📌 Fixture Reference:\n- Mock Capacitor plugins.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for Services.\n2. Component tests for Ionic Pages.\n`;
  }
};
