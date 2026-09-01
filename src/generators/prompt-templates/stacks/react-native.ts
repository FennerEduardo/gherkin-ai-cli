import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const reactNativeTemplate: PromptTemplate = {
  name: 'React Native',
  match: (config) => config.stack.framework === 'react-native',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN STATE MANAGER (React Native)', `Implement front-end state management and API ports.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Language: TypeScript/JavaScript\n- Separate state logic (Zustand/Redux/Context) from UI Components.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. State Stores\n2. API Client Ports\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('UI DEVELOPER AGENT (React Native)', 'Implement screens, components, and navigation.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: React Native\n- Navigation: React Navigation\n- Styling: StyleSheet / NativeWind\n` +
      `\n📌 Implementation Rules:\n- Ensure components are functional and use hooks.\n- Map state from stores to UI.\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (React Native Testing Library)', `Implement automated component tests.`, ctx) +
      `\n📌 Fixture Reference:\n- Mock API calls and state stores.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Component rendering tests.\n2. User interaction tests.\n`;
  }
};
