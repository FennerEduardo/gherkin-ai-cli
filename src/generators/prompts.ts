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
import { StepIndexer } from '../core/step-indexer';
import { ContextExtractor } from '../core/context-extractor';

export function generatePrompts(parsed: ParsedFeature, config: GherkinAIConfig): Record<string, string> {
  const arch = getArchRule(config.architecture);
  const spec = getStackSpec(config.stack);
  const isSpanishUser = getGlobalUserLocale() === 'es';

  const indexer = new StepIndexer();
  const availableSteps = indexer.getAvailableSteps(process.cwd());

  const extractor = new ContextExtractor();
  const appContext = extractor.extract(process.cwd());

  const ctx: PromptTemplateContext = {
    config,
    parsed,
    arch,
    spec,
    isSpanishUser,
    availableSteps,
    appContext
  };

  const template = resolvePromptTemplate(config);

  const result: Record<string, string> = {
    'domain-agent.md': template.generateDomainAgent(ctx),
    'backend-agent.md': template.generateBackendAgent(ctx),
    'qa-agent.md': template.generateQaAgent(ctx)
  };

  // Inject DOM and Data Models to Backend/QA/Domain agents
  let contextDict = '';
  if (ctx.appContext.dataModels.length > 0) {
    contextDict += `\n## [MANDATORY] Extracted Data Models (Prisma)\n\`\`\`prisma\n${ctx.appContext.dataModels.join('\n\n')}\n\`\`\`\n`;
    result['backend-agent.md'] += contextDict;
    result['domain-agent.md'] += contextDict;
  }
  
  if (ctx.appContext.domSelectors.length > 0) {
    let domDict = `\n## [MANDATORY] Discovered DOM Selectors (POM)\nYou must use these selectors in your tests:\n${ctx.appContext.domSelectors.map(s => `- \`${s}\``).join('\n')}\n`;
    result['qa-agent.md'] += domDict;
  }

  // Inject extracted Step Definitions (AST Indexing) to force step reuse
  if (ctx.availableSteps && ctx.availableSteps.length > 0) {
    let stepsDict = `\n## [MANDATORY] Step Definitions Dictionary\n`;
    stepsDict += `You MUST reuse the following existing Step Definitions whenever possible instead of inventing new ones:\n\n`;
    ctx.availableSteps.forEach(st => {
      stepsDict += `- \`${st.keyword} ${st.pattern}\` (found in ${st.filePath})\n`;
    });
    result['qa-agent.md'] += stepsDict;
  }

  if (template.generateAiAgent && config.stack.aiEngine) {
    result['ai-engineer-agent.md'] = template.generateAiAgent(ctx);
    if (contextDict) result['ai-engineer-agent.md'] += contextDict;
    if (ctx.appContext.domSelectors.length > 0) {
      result['ai-engineer-agent.md'] += `\n## [MANDATORY] Discovered DOM Selectors (POM)\nYou must use these selectors in your UI tests:\n${ctx.appContext.domSelectors.map(s => `- \`${s}\``).join('\n')}\n`;
    }
    if (ctx.availableSteps && ctx.availableSteps.length > 0) {
      result['ai-engineer-agent.md'] += `\n## [MANDATORY] Step Definitions Dictionary\nYou MUST reuse existing Step Definitions in QA specs:\n${ctx.availableSteps.map(s => `- \`${s.keyword} ${s.pattern}\``).join('\n')}\n`;
    }
  }

  return result;
}
