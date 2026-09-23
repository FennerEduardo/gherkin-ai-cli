import { ParsedFeature } from './specification-interface';

/**
 * Stub parser for Markdown EARS format.
 * Full implementation planned for Phase 4 (Interoperability).
 */
export class MarkdownEarsParser {
  parse(content: string): ParsedFeature {
    return {
      featureName: 'EARS Feature',
      descriptionLines: ['Parsed from EARS format'],
      tags: [],
      scenarios: [],
      domainAnalysis: {
        actors: [],
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
