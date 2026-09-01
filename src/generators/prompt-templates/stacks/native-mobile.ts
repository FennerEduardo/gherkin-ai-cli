import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const nativeMobileTemplate: PromptTemplate = {
  name: 'Native Mobile (iOS Swift / Android Kotlin)',
  match: (config) => ['ios-native', 'android-native'].includes(config.stack.framework),
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`DOMAIN STATE MANAGER (${ctx.config.stack.language})`, `Implement front-end state management and API ports.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Language: ${ctx.config.stack.language}\n- Separate pure state logic (ViewModels/StateHolders) from UI Views.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. State Stores or ViewModels\n2. API Client Ports or Repository Interfaces\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader(`UI DEVELOPER AGENT (${ctx.config.stack.framework})`, 'Implement Native Screens, UI components, and navigation.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: ${ctx.config.stack.framework === 'ios-native' ? 'SwiftUI/UIKit' : 'Jetpack Compose / XML'}\n` +
      `\n📌 Implementation Rules:\n- Ensure components are modular and responsive.\n- Map state from ViewModels to UI efficiently.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Mobile Testing)', `Implement automated component and E2E tests.`, ctx) +
      `\n📌 Fixture Reference:\n- Mock API calls and state.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. UI/Snapshot tests.\n2. Unit tests for ViewModels.\n`;
  }
};
