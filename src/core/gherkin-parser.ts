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

/** Articles, prepositions, conjunctions and common step verbs (en/es) that precede a quoted value without naming a field. */
const NOT_A_FIELD = new Set([
  'a', 'an', 'the', 'this', 'that', 'its', 'their', 'his', 'her', 'my', 'our', 'your',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'for', 'of', 'to', 'in', 'on', 'at', 'from', 'by', 'as', 'into', 'onto', 'than', 'via', 'and', 'or', 'not', 'no',
  'become', 'becomes', 'became', 'equals', 'contains', 'shows', 'show', 'displays', 'display', 'reads', 'read', 'says', 'see', 'sees', 'has', 'have', 'had',
  'named', 'called', 'titled', 'labeled', 'labelled', 'set', 'sets', 'enter', 'enters', 'type', 'types', 'select', 'selects', 'choose', 'chooses', 'click', 'clicks',
  'register', 'registers', 'create', 'creates', 'add', 'adds', 'submit', 'submits', 'send', 'sends', 'receive', 'receives', 'publish', 'publishes', 'request', 'requests',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'su', 'sus', 'este', 'esta',
  'con', 'de', 'del', 'en', 'para', 'por', 'como', 'al', 'y', 'o', 'es', 'son', 'era', 'que', 'se', 'sin',
  'registra', 'crea', 'ingresa', 'tiene', 've', 'muestra', 'recibe', 'envia', 'envía', 'llamado', 'llamada', 'titulado', 'titulada'
]);

/** Nouns that end like verb forms but are fields. */
const KNOWN_FIELD_NOUNS = new Set(['setting', 'heading', 'rating', 'ranking', 'billing', 'shipping', 'building', 'listing', 'booking', 'meeting', 'seed', 'speed', 'feed', 'need', 'bed']);

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
  const backgroundSteps: StepModel[] = [];
  let backgroundName = '';

  type Child = (typeof feature.children)[number];
  type GherkinStep = NonNullable<Child['scenario']>['steps'][number];

  const convertSteps = (gherkinSteps: readonly GherkinStep[], scenarioTags: string[]): StepModel[] => {
    const steps: StepModel[] = [];
    for (const step of gherkinSteps) {
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
    return steps;
  };

  // Feature children are Background, Scenario (Outline) or Rule; a Rule holds its own Background and scenarios.
  const visit = (children: readonly Child[], inheritedTags: string[]) => {
    for (const child of children) {
      if (child.background) {
        backgroundName ||= child.background.name;
        for (const st of convertSteps(child.background.steps, inheritedTags)) {
          if (!backgroundSteps.some(b => b.keyword === st.keyword && b.text === st.text)) backgroundSteps.push(st);
        }
      } else if (child.scenario) {
        const scenarioTags = [...inheritedTags, ...child.scenario.tags.map(t => t.name)];
        scenarios.push({ name: child.scenario.name, tags: scenarioTags, steps: convertSteps(child.scenario.steps, scenarioTags) });
      } else if (child.rule) {
        visit(child.rule.children as readonly Child[], [...inheritedTags, ...child.rule.tags.map(t => t.name)]);
      }
    }
  };
  visit(feature.children, []);
  const background: ScenarioModel | undefined = backgroundSteps.length
    ? { name: backgroundName || 'Background', tags: [], steps: backgroundSteps }
    : undefined;

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

  [...(background ? [background] : []), ...scenarios].forEach(sc => {
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

      // Fields from DataTables come from the header row only (the other rows are values). A two-column
      // "| field | value |" table lists its fields down the first column instead.
      const rows = st.text.split('\n').filter(l => l.startsWith('|')).map(l => l.split('|').map(c => c.trim()).filter(c => c));
      if (rows.length) {
        const vertical = rows[0].length === 2 && /^(field|campo|name|nombre|attribute|atributo|property|propiedad)$/i.test(rows[0][0]);
        const names = vertical ? rows.slice(1).map(r => r[0]) : rows[0];
        for (const cell of names) {
          const fieldName = cell.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          if (fieldName && fieldName.length > 2 && !/^_*\d/.test(fieldName) && !fieldsMap.has(fieldName)) {
            fieldsMap.set(fieldName, { name: fieldName, type: 'string', validations: [] });
          }
        }
      }

      // Semantic extraction from quotes
      // The field word must start with a letter at a word boundary: in `monto 250.00 "USD"` the "00" is not a field.
      const quoteRegex = /(?:^|\s)([A-Za-z_]\w*)\s+"([^"]+)"/g;
      let qMatch;
      while ((qMatch = quoteRegex.exec(st.text)) !== null) {
        const fieldName = qMatch[1].toLowerCase();
        
        // The word before a quoted value is a field only when it is a noun: `email "ana@x.org"` yes,
        // `becomes "active"` / `in "Spring 2026"` / `registers "Ana"` no.
        if (NOT_A_FIELD.has(fieldName) || /^\w+(ed|ing)$/.test(fieldName) && !KNOWN_FIELD_NOUNS.has(fieldName)) continue;

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
    ...(background ? { background } : {}),
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
