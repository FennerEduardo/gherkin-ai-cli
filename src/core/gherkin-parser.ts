/* ==========================================================================
   gherkin-ai-cli - Gherkin Feature Parser & AST Model (English & Spanish i18n)
   ========================================================================== */

export interface StepModel {
  keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
  text: string;
}

export interface ScenarioModel {
  name: string;
  steps: StepModel[];
}

export interface ParsedFeature {
  featureName: string;
  descriptionLines: string[];
  scenarios: ScenarioModel[];
  domainAnalysis: {
    actors: string[];
    commands: string[];
    queries: string[];
    events: string[];
    fixtures: string[];
  };
}

export function parseGherkinText(gherkinText: string): ParsedFeature {
  const lines = gherkinText.split('\n');
  let featureName = 'Feature Specification';
  const descriptionLines: string[] = [];
  const scenarios: ScenarioModel[] = [];
  
  let currentScenario: ScenarioModel | null = null;
  let inHeader = true;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Feature / Característica Header
    if (/^(Feature|Característica|Requerimiento):/i.test(line)) {
      featureName = line.replace(/^(Feature|Característica|Requerimiento):/i, '').trim();
      inHeader = true;
      continue;
    }

    // Scenario / Escenario Header
    if (/^(Scenario|Escenario|Scenario Outline|Esquema del escenario):/i.test(line)) {
      inHeader = false;
      const name = line.replace(/^(Scenario|Escenario|Scenario Outline|Esquema del escenario):/i, '').trim();
      currentScenario = { name, steps: [] };
      scenarios.push(currentScenario);
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

      currentScenario.steps.push({ keyword, text: stepMatch[2].trim() });
    }
  }

  // Domain Elements Extraction
  const actors = new Set<string>();
  const commands: string[] = [];
  const queries: string[] = [];
  const events: string[] = [];
  const fixtures: string[] = [];

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
    });
  });

  return {
    featureName,
    descriptionLines,
    scenarios,
    domainAnalysis: {
      actors: Array.from(actors),
      commands,
      queries,
      events,
      fixtures
    }
  };
}
