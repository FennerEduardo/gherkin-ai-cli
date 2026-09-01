import { PromptTemplate, PromptTemplateContext, buildCommonHeader, buildFeatureSpec, buildScenarios } from '../base';

export const flutterTemplate: PromptTemplate = {
  name: 'Flutter / Dart',
  match: (config) => config.stack.framework === 'flutter',
  generateDomainAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('DOMAIN ARCHITECT AGENT (Dart)', `Implement domain entities and BLoC/Riverpod state.`, ctx) +
      buildFeatureSpec(ctx) +
      `\n🛠️ Technical Rails:\n- Language: Dart\n- Implement pure Dart classes for Domain.\n- Separate business logic from UI using BLoC or Riverpod.\n` +
      `\n📂 Folder Structure Target:\n${ctx.arch.folderStructure}\n\n` +
      buildScenarios(ctx) +
      `\nMust Output:\n1. Dart Models\n2. State Management Classes\n`;
  },
  generateBackendAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('UI DEVELOPER AGENT (Flutter)', 'Implement Flutter Widgets, Screens, and Navigation.', ctx) +
      `\n🛠️ Target Technology Stack:\n- Framework: Flutter\n- Routing: GoRouter or Navigator 2.0\n` +
      `\n📌 Implementation Rules:\n- Keep build methods clean.\n- Consume state using BlocBuilder or Consumer (Riverpod).\n\n` +
      buildScenarios(ctx);
  },
  generateQaAgent: (ctx: PromptTemplateContext) => {
    return buildCommonHeader('QA AGENT (Flutter Test)', `Implement automated widget and unit tests.`, ctx) +
      `\n📌 Fixture Reference:\n- Use flutter_test package.\n- Mock dependencies using Mockito or Mocktail.\n\n` +
      buildScenarios(ctx) +
      `\n🎯 Testing Deliverables:\n1. Unit tests for BLoC/State.\n2. Widget tests for UI components.\n`;
  }
};
