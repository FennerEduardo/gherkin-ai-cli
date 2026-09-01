import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const desktopClientTemplate: PromptTemplate = {
  name: 'Desktop Client (Electron/Tauri)',
  match: (config) => config.architecture === 'desktop' || ['electron', 'tauri'].includes(config.stack.framework),
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('CORE ARCHITECT AGENT (Desktop)', `Implement core business logic independent of IPC mechanisms.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Isolate main process (Node/Rust) from renderer process logic.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Core Domain Models\n2. IPC Interface Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`SYSTEM DEVELOPER AGENT (${ctx.config.stack.framework})`, 'Implement main process logic and OS integrations.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework}\n` +
      `\n📌 Implementation Rules:\n- Implement secure IPC handlers/commands.\n- Access file system or OS APIs securely.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT', `Implement automated tests for desktop logic.`, ctx) +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for core logic.\n2. E2E tests using appropriate drivers (e.g., Spectron or Playwright).\n`;
  }
};
