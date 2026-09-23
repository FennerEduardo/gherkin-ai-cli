/* ==========================================================================
   gherkin-ai-cli - Markdown / EARS Specification Parser
   ========================================================================== */

import { ParsedFeature, ScenarioModel, StepModel, ISpecificationParser, SpecificationParserOptions } from './specification-interface';

export class MarkdownEarsParser implements ISpecificationParser {
  parse(content: string, options?: SpecificationParserOptions): ParsedFeature {
    const lines = content.split('\n');
    let featureName = 'Unknown Feature';
    const descriptionLines: string[] = [];
    const tags: string[] = [];
    const scenarios: ScenarioModel[] = [];

    let currentScenario: ScenarioModel | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('# ')) {
        featureName = trimmed.substring(2).trim();
      } else if (trimmed.startsWith('## ')) {
        if (currentScenario) {
          scenarios.push(currentScenario);
        }
        currentScenario = {
          name: trimmed.substring(3).trim(),
          tags: [],
          steps: []
        };
      } else if (trimmed.startsWith('@')) {
         if (currentScenario) {
             currentScenario.tags.push(...trimmed.split(/\s+/).map(t => t.substring(1)));
         } else {
             tags.push(...trimmed.split(/\s+/).map(t => t.substring(1)));
         }
      } else if (trimmed.match(/^[-*]\s+/)) {
        if (currentScenario) {
          const stepText = trimmed.replace(/^[-*]\s+(\[[x ]\])?\s*/, '');
          
          let keyword: StepModel['keyword'] = 'Then';
          const kwMatch = stepText.match(/^(given|when|then|and|but)\s+(.*)/i);
          if (kwMatch) {
             keyword = kwMatch[1].charAt(0).toUpperCase() + kwMatch[1].slice(1).toLowerCase() as any;
          } else if (stepText.match(/^(if|while|where)/i)) {
             keyword = 'When';
          }

          currentScenario.steps.push({
            keyword,
            text: stepText,
            tags: currentScenario.tags
          });
        } else {
          descriptionLines.push(trimmed);
        }
      } else {
         if (!currentScenario) {
            descriptionLines.push(trimmed);
         }
      }
    }

    if (currentScenario) {
      scenarios.push(currentScenario);
    }

    // Extract rudimentary domain hints so ir-builder can function
    const actors = new Set<string>();
    descriptionLines.forEach(l => {
      if (/as a|as an/i.test(l)) actors.add(l);
    });

    return {
      featureName,
      descriptionLines,
      tags,
      scenarios,
      domainAnalysis: {
        actors: Array.from(actors),
        commands: [],
        queries: [],
        events: [],
        fixtures: [],
        fields: [],
        httpCodes: []
      }
    };
  }
}
