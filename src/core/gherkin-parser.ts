/* ==========================================================================
   gherkin-ai-cli - Gherkin Feature Parser & AST Model
   Powered by @cucumber/gherkin
   ========================================================================== */

import { generateMessages, dialects } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType, StepKeywordType } from '@cucumber/messages';
import { ParsedFeature, ScenarioModel, StepModel, DomainField, ISpecificationParser, SpecificationParserOptions } from './parsers/specification-interface';
export { ParsedFeature, ScenarioModel, StepModel, DomainField, ISpecificationParser, SpecificationParserOptions };

export class GherkinParser implements ISpecificationParser {
  parse(content: string, options?: SpecificationParserOptions): ParsedFeature {
    return parseGherkinText(content);
  }
}

const FEATURE_KEYWORDS = [...new Set(Object.values(dialects).flatMap(d => d.feature))];

/** True when the text has a Gherkin Feature line in any dialect (comments such as "# language: es" may precede it). */
function looksLikeGherkin(text: string): boolean {
  return text.split('\n').some(line => {
    const l = line.trim();
    return FEATURE_KEYWORDS.some(k => l.startsWith(`${k}:`));
  });
}

export function parseGherkinText(gherkinText: string): ParsedFeature {
  const trimmed = gherkinText.trim();
  if ((trimmed.startsWith('#') || trimmed.match(/^[-*]\s+/)) && !looksLikeGherkin(gherkinText)) {
    try {
      const { MarkdownEarsParser } = require('./parsers/markdown-ears-parser');
      return new MarkdownEarsParser().parse(gherkinText);
    } catch (e) {
      // Fallback if Phase 4 parser is not yet fully available in this environment
    }
  }

  const options = {
    includeSource: false,
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.uuid(),
  };

  const msgs = generateMessages(gherkinText, 'feature.feature', SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, options);
  const docMsg = msgs.find(m => m.gherkinDocument);
  
  if (!docMsg || !docMsg.gherkinDocument || !docMsg.gherkinDocument.feature) {
    throw new Error('Invalid Gherkin specification. Could not parse feature.');
  }

  const feature = docMsg.gherkinDocument.feature;
  const featureName = feature.name;
  const descriptionLines = feature.description ? feature.description.split('\n').map(l => l.trim()).filter(l => l) : [];
  const featureTags = feature.tags.map(t => t.name);

  const scenarios: ScenarioModel[] = [];

  for (const child of feature.children) {
    if (child.scenario) {
      const scenario = child.scenario;
      const scenarioTags = scenario.tags.map(t => t.name);
      const steps: StepModel[] = [];

      for (const step of scenario.steps) {
        const kwStr = step.keyword.trim().toLowerCase();
        let keyword: StepModel['keyword'] = 'Given';

        // keywordType is dialect-independent (Dado/Étant donné/Angenommen are all Context).
        if (step.keywordType === StepKeywordType.CONTEXT) keyword = 'Given';
        else if (step.keywordType === StepKeywordType.ACTION) keyword = 'When';
        else if (step.keywordType === StepKeywordType.OUTCOME) keyword = 'Then';
        else if (step.keywordType === StepKeywordType.CONJUNCTION) keyword = ['but', 'pero', 'mais', 'aber', 'ma'].includes(kwStr) ? 'But' : 'And';
        else if (['when', 'cuando'].includes(kwStr)) keyword = 'When';
        else if (['then', 'entonces'].includes(kwStr)) keyword = 'Then';
        else if (['and', 'y', 'e'].includes(kwStr)) keyword = 'And';
        else if (['but', 'pero'].includes(kwStr)) keyword = 'But';

        let stepText = step.text;

        // Support for DataTables in steps
        if (step.dataTable) {
          const rows = step.dataTable.rows.map(r => '| ' + r.cells.map(c => c.value).join(' | ') + ' |').join('\n');
          stepText += '\n' + rows;
        }

        // Support for DocStrings
        if (step.docString) {
          stepText += '\n"""\n' + step.docString.content + '\n"""';
        }

        steps.push({
          keyword,
          text: stepText,
          tags: [...featureTags, ...scenarioTags] // Cucumber doesn't support tags on steps natively, we inherit
        });
      }

      scenarios.push({
        name: scenario.name,
        tags: scenarioTags,
        steps
      });
    }
  }

  // Domain Elements Extraction
  const actors = new Set<string>();
  const commands: string[] = [];
  const queries: string[] = [];
  const events: string[] = [];
  const fixtures: string[] = [];
  const fieldsMap = new Map<string, DomainField>();

  descriptionLines.forEach(line => {
    if (/as a|as an|como/i.test(line)) actors.add(line);
  });

  const httpCodes = new Set<string>();

  scenarios.forEach(sc => {
    sc.steps.forEach(st => {
      if (st.keyword === 'Given') {
        fixtures.push(st.text);
      } else if (st.keyword === 'When') {
        commands.push(st.text);
      } else if (st.keyword === 'Then') {
        if (/event|publishes|emits|broadcasts|evento|emite/i.test(st.text)) {
          events.push(st.text);
        } else {
          queries.push(st.text);
        }
        const httpCodeMatch = st.text.match(/HTTP (?:status )?(\d{3})/i);
        if (httpCodeMatch) {
          httpCodes.add(httpCodeMatch[1]);
        }
      }

      // Enhanced semantic field extraction, especially from DataTables
      const lines = st.text.split('\n');
      for (const line of lines) {
        if (line.startsWith('|')) {
          const cells = line.split('|').map(c => c.trim()).filter(c => c);
          cells.forEach(cell => {
            const fieldName = cell.toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (fieldName && fieldName.length > 2) {
              if (!fieldsMap.has(fieldName)) {
                fieldsMap.set(fieldName, { name: fieldName, type: 'string', validations: [] });
              }
            }
          });
        }
      }

      // Semantic extraction from quotes
      const quoteRegex = /(\w+)\s+"([^"]+)"/g;
      let qMatch;
      while ((qMatch = quoteRegex.exec(st.text)) !== null) {
        const fieldName = qMatch[1].toLowerCase();
        
        // Ignore stop words (articles)
        if (['a', 'an', 'the', 'el', 'la', 'un', 'una', 'with', 'is', 'for', 'of'].includes(fieldName)) continue;

        let type = 'string';
        if (!isNaN(Number(qMatch[2]))) type = 'number';
        
        if (!fieldsMap.has(fieldName)) {
          fieldsMap.set(fieldName, { name: fieldName, type, validations: [] });
        }
        
        const existing = fieldsMap.get(fieldName)!;
        
        // Extract inline tags from step text
        const inlineTags = st.text.match(/@[\w:(),]+/g) || [];
        inlineTags.forEach(tag => {
          if (!existing.validations.includes(tag)) {
            existing.validations.push(tag);
          }
        });
      }
    });
  });

  // Ensure default success response if none found
  if (httpCodes.size === 0) {
    httpCodes.add('200');
  }

  return {
    featureName,
    language: feature.language,
    descriptionLines,
    tags: featureTags,
    scenarios,
    domainAnalysis: {
      actors: Array.from(actors),
      commands,
      queries,
      events,
      fixtures,
      fields: Array.from(fieldsMap.values()),
      httpCodes: Array.from(httpCodes)
    }
  };
}
