/* ==========================================================================
   gherkin-ai-cli - Generic Specification Parser Interface
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
    httpCodes: string[];
  };
}

export interface SpecificationParserOptions {
  sourceFile: string;
}

export interface ISpecificationParser {
  /**
   * Parses the raw text content into a generic ParsedFeature (AST equivalent).
   */
  parse(content: string, options?: SpecificationParserOptions): ParsedFeature;
}
