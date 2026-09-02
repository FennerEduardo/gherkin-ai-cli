/* ==========================================================================
   gherkin-ai-cli - Gherkin Feature Parser & AST Model
   Powered by @cucumber/gherkin
   ========================================================================== */

import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';

export interface StepModel {
  keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
  text: string;
  tags: string[];
}

export interface ScenarioModel {
  name: string;
  steps: StepModel[];
  tags: string[];
}

export interface DomainField {
  name: string;
  type: string;
  validations: string[];
}

export interface ParsedFeature {
  featureName: string;
  descriptionLines: string[];
  tags: string[];
  scenarios: ScenarioModel[];
  domainAnalysis: {
    actors: string[];
    commands: string[];
    queries: string[];
    events: string[];
    fixtures: string[];
    fields: DomainField[];
  };
}

export function parseGherkinText(gherkinText: string): ParsedFeature {
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
        let kwStr = step.keyword.trim().toLowerCase();
        let keyword: StepModel['keyword'] = 'Given';

        if (['given', 'dado', 'dada', 'dados', 'dadas'].includes(kwStr)) keyword = 'Given';
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

  return {
    featureName,
    descriptionLines,
    tags: featureTags,
    scenarios,
    domainAnalysis: {
      actors: Array.from(actors),
      commands,
      queries,
      events,
      fixtures,
      fields: Array.from(fieldsMap.values())
    }
  };
}
