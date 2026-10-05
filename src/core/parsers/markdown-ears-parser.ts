import { ParsedFeature, ISpecificationParser, SpecificationParserOptions, ScenarioModel, StepModel, DomainField } from './specification-interface';

export class MarkdownEarsParser implements ISpecificationParser {
  parse(content: string, options?: SpecificationParserOptions): ParsedFeature {
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let featureName = 'Unnamed Feature';
    const descriptionLines: string[] = [];
    const scenarios: ScenarioModel[] = [];
    
    let currentScenario: ScenarioModel | null = null;

    const actors = new Set<string>();
    const commands: string[] = [];
    const queries: string[] = [];
    const events: string[] = [];
    const fixtures: string[] = [];
    const fieldsMap = new Map<string, DomainField>();
    const httpCodes = new Set<string>();

    for (const line of lines) {
      // Parse Headers
      if (line.startsWith('# ')) {
        featureName = line.replace('# ', '').trim();
      } else if (line.startsWith('## ')) {
        // Start a new logical grouping as a scenario
        if (currentScenario) {
          scenarios.push(currentScenario);
        }
        currentScenario = {
          name: line.replace('## ', '').trim(),
          tags: [],
          steps: []
        };
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        // Parse EARS syntax items
        const text = line.substring(2).trim();
        if (!currentScenario) {
          currentScenario = { name: 'General Requirements', tags: [], steps: [] };
        }
        
        let keyword: StepModel['keyword'] = 'Then';
        
        // EARS Patterns matching
        // Ubiquitous: "The <system name> shall <system response>"
        // Event-driven: "When <trigger>, the <system name> shall <system response>"
        // State-driven: "While <precondition>, the <system name> shall <system response>"
        // Unwanted behavior: "If <trigger>, then the <system name> shall <system response>"
        // Optional feature: "Where <feature is included>, the <system name> shall <system response>"
        
        if (text.toLowerCase().startsWith('when ')) {
          keyword = 'When';
          commands.push(text);
        } else if (text.toLowerCase().startsWith('if ') || text.toLowerCase().startsWith('while ') || text.toLowerCase().startsWith('where ')) {
          keyword = 'Given';
          fixtures.push(text);
        } else if (text.toLowerCase().includes(' shall ')) {
          keyword = 'Then';
          if (/event|publishes|emits|broadcasts|evento|emite/i.test(text)) {
            events.push(text);
          } else {
            queries.push(text);
          }
        }
        
        const httpCodeMatch = text.match(/HTTP (?:status )?(\d{3})/i);
        if (httpCodeMatch) {
          httpCodes.add(httpCodeMatch[1]);
        }

        currentScenario.steps.push({
          keyword,
          text,
          tags: []
        });

      } else {
        // It's part of description
        descriptionLines.push(line);
        if (/as a|as an|como/i.test(line)) {
          actors.add(line);
        }
      }
    }

    if (currentScenario) {
      scenarios.push(currentScenario);
    }

    if (httpCodes.size === 0) {
      httpCodes.add('200');
    }

    return {
      featureName,
      descriptionLines,
      tags: [],
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
}
