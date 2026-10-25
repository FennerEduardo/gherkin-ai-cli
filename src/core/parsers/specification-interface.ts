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
  /** 1-based line of the Scenario keyword in the source file, when parsed from Gherkin. */
  line?: number;
}

export interface DomainField {
  name: string;
  type: string;
  validations: string[];
  /**
   * Where the field was found: a DataTable header (a declared field) or the word before a quoted value in a
   * step (`the teacher "t-7"`: often an identifier, not a field). Only table fields become DTOs and columns.
   */
  source?: 'table' | 'step';
}

export interface ParsedFeature {
  featureName: string;
  /** Gherkin dialect ("en", "es", ...) when parsed from a .feature file. */
  language?: string;
  descriptionLines: string[];
  tags: string[];
  scenarios: ScenarioModel[];
  /** Background steps (feature-level, then Rule-level), which run before every scenario. */
  background?: ScenarioModel;
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
