import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const frontendWebTemplate: PromptTemplate = {
  name: 'Modern Web Frontend (React/Vue/Angular/Svelte/Astro)',
  match: (config) => ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'astro', 'solid-js'].includes(config.stack.framework),
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN STATE MANAGER (Frontend)', `Implement front-end state management and API ports.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Language: ${ctx.config.stack.language}\n- Framework: ${ctx.config.stack.framework}\n- Separate pure state logic from UI view components.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. State Stores/Contexts\n2. API Client Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('UI DEVELOPER AGENT (Frontend)', 'Implement pages, UI components, and routing.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n- Styling: Ensure responsive design.\n` +
      `\n📌 Implementation Rules:\n- Ensure components are modular and reusable.\n- Map state from stores to UI efficiently.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Frontend Testing)', `Implement automated component and E2E tests using ${ctx.config.stack.testing}.`, ctx) +
      `\n📌 Fixture Reference:\n- Mock API calls (e.g. MSW) and state stores.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Component rendering tests.\n2. User interaction tests.\n`;
  },
  generateAiAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('AI ENGINEER AGENT (Web)', 'Implement LLM integrations in the browser or frontend server.', ctx) +
      `\n🛠️ Target AI Tech: ${ctx.config.stack.aiEngine}\n` +
      `\n📌 Implementation Rules:\n- Safely manage API keys.\n- Use streams for LLM responses (e.g., Vercel AI SDK if applicable).\n\n` +
      buildScenarios(ctx);
  }
};
