/* ==========================================================================
   gherkin-ai-cli - Gherkin Feature Parser & AST Model
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

    if (line.startsWith('Feature:')) {
      featureName = line.replace('Feature:', '').trim();
      inHeader = true;
      continue;
    }

    if (line.startsWith('Scenario:') || line.startsWith('Scenario Outline:')) {
      inHeader = false;
      const name = line.replace(/Scenario( Outline)?:/, '').trim();
      currentScenario = { name, steps: [] };
      scenarios.push(currentScenario);
      continue;
    }

    if (inHeader) {
      descriptionLines.push(line);
      continue;
    }

    const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (stepMatch && currentScenario) {
      const keyword = (stepMatch[1].charAt(0).toUpperCase() + stepMatch[1].slice(1).toLowerCase()) as StepModel['keyword'];
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
        if (/event|publishes|emits|broadcasts|evento/i.test(st.text)) {
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
