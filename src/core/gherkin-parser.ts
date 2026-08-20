/* ==========================================================================
   gherkin-ai-cli - Gherkin Feature Parser & AST Model (English & Spanish i18n)
   ========================================================================== */

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
  const lines = gherkinText.split('\n');
  let featureName = 'Feature Specification';
  const descriptionLines: string[] = [];
  const featureTags: string[] = [];
  const scenarios: ScenarioModel[] = [];
  
  let currentScenario: ScenarioModel | null = null;
  let inHeader = true;
  let accumulatedTags: string[] = [];

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Collect tags (e.g. @validate:email)
    if (line.startsWith('@')) {
      const lineTags = line.split(/\s+/).filter(t => t.startsWith('@'));
      accumulatedTags.push(...lineTags);
      continue;
    }

    // Feature / Característica Header
    if (/^(Feature|Característica|Requerimiento):/i.test(line)) {
      featureName = line.replace(/^(Feature|Característica|Requerimiento):/i, '').trim();
      featureTags.push(...accumulatedTags);
      accumulatedTags = [];
      inHeader = true;
      continue;
    }

    // Scenario / Escenario Header
    if (/^(Scenario|Escenario|Scenario Outline|Esquema del escenario):/i.test(line)) {
      inHeader = false;
      const name = line.replace(/^(Scenario|Escenario|Scenario Outline|Esquema del escenario):/i, '').trim();
      currentScenario = { name, steps: [], tags: [...accumulatedTags] };
      scenarios.push(currentScenario);
      accumulatedTags = [];
      continue;
    }

    if (inHeader) {
      descriptionLines.push(line);
      continue;
    }

    // Steps Matching (EN & ES)
    const stepMatch = line.match(/^(Given|Dado|Dada|Dados|Dadas|When|Cuando|Then|Entonces|And|Y|E|But|Pero)\s+(.+)$/i);
    if (stepMatch && currentScenario) {
      const rawKw = stepMatch[1].toLowerCase();
      let keyword: StepModel['keyword'] = 'Given';

      if (['given', 'dado', 'dada', 'dados', 'dadas'].includes(rawKw)) keyword = 'Given';
      else if (['when', 'cuando'].includes(rawKw)) keyword = 'When';
      else if (['then', 'entonces'].includes(rawKw)) keyword = 'Then';
      else if (['and', 'y', 'e'].includes(rawKw)) keyword = 'And';
      else if (['but', 'pero'].includes(rawKw)) keyword = 'But';

      let text = stepMatch[2].trim();
      
      // Look for inline tags at the end of the step (e.g. Given an email "test@test.com" @validate:email)
      const inlineTags: string[] = [];
      text = text.replace(/(^|\s)(@[a-zA-Z0-9_:]+(?:\([^)]+\))?)/g, (match, space, tag) => {
        inlineTags.push(tag);
        return space;
      }).trim();

      currentScenario.steps.push({ 
        keyword, 
        text, 
        tags: [...accumulatedTags, ...inlineTags] 
      });
      accumulatedTags = [];
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

      // Very simple semantic field extraction: looking for quotes and linking to step tags
      // If a step has @validate:email and mentions "email", we infer a field.
      // We also look for field names right before quoted strings (e.g., email "test@ex.com")
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
        st.tags.forEach(tag => {
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
