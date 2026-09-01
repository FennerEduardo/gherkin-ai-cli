/* ==========================================================================
   gherkin-ai-cli - Executable AI Agent Prompt Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { getArchRule } from '../core/arch-rules';
import { getStackSpec } from '../core/stack-specs';
import { resolvePromptTemplate } from './prompt-templates/factory';
import { PromptTemplateContext } from './prompt-templates/base';
import { getGlobalUserLocale } from '../utils/i18n-cli';

export function generatePrompts(parsed: ParsedFeature, config: GherkinAIConfig): Record<string, string> {
  const arch = getArchRule(config.architecture);
  const spec = getStackSpec(config.stack);
  const isSpanishUser = getGlobalUserLocale() === 'es';

  const ctx: PromptTemplateContext = {
    config,
    parsed,
    arch,
    spec,
    isSpanishUser
  };

  const template = resolvePromptTemplate(config);

  return {
    'domain-agent.md': template.generateDomainAgent(ctx),
    'backend-agent.md': template.generateBackendAgent(ctx),
    'qa-agent.md': template.generateQaAgent(ctx)
  };
}
