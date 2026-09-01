import { GherkinAIConfig } from '../../core/config';
import { ParsedFeature } from '../../core/gherkin-parser';
import { ArchRuleSpec } from '../../core/arch-rules';
import { StackSpec } from '../../core/stack-specs';

export interface PromptTemplateContext {
  config: GherkinAIConfig;
  parsed: ParsedFeature;
  arch: ArchRuleSpec;
  spec: StackSpec;
  isSpanishUser: boolean;
}

export interface PromptTemplate {
  name: string;
  match: (config: GherkinAIConfig) => boolean;
  generateDomainAgent: (ctx: PromptTemplateContext) => string;
  generateBackendAgent: (ctx: PromptTemplateContext) => string;
  generateQaAgent: (ctx: PromptTemplateContext) => string;
}

export function buildCommonHeader(role: string, objective: string, ctx: PromptTemplateContext): string {
  let header = `🤖 ROLE: ${role}\n`;
  header += `Objective: ${objective}\n\n`;
  if (ctx.isSpanishUser) {
    header += `> [!IMPORTANT]\n> User prefers Spanish. Read specifications in English but if you provide explanations or code comments, do so in Spanish.\n\n`;
  }
  return header;
}

export function buildFeatureSpec(ctx: PromptTemplateContext): string {
  return `📌 Feature Specification: ${ctx.parsed.featureName}\n${ctx.parsed.descriptionLines.map(l => `> ${l}`).join('\n')}\n`;
}

export function buildScenarios(ctx: PromptTemplateContext): string {
  return `🎯 Scenarios to Fulfill:\n${ctx.parsed.scenarios.map((sc, i) => `${i + 1}. "${sc.name}"`).join('\n')}\n`;
}
