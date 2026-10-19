/* ==========================================================================
   gherkin-ai-cli - Explain the IR (ghk lint --explain-ir)

   Shows the names the generator will use for a feature (aggregate, command
   route, commands, events) and where each one comes from: an explicit tag,
   an identifier in the steps, an English verb heuristic, or a default. The
   suggestions say which tag makes an inferred name explicit.
   ========================================================================== */

import type { ParsedFeature } from './gherkin-parser';
import { buildIR } from './ir-builder';
import { buildDomainModel } from '../generators/kernel/domain-model';
import { aggregateTagName, declaredTagValues } from '../utils/naming';

export type NameSource = 'tag' | 'step identifier' | 'English verb heuristic' | 'step text' | 'feature name' | 'default';

export interface IrExplanation {
  feature: string;
  file: string;
  aggregate: { name: string; source: NameSource };
  route: string;
  commands: { name: string; event: string; source: NameSource }[];
  events: { name: string; source: NameSource }[];
  suggestions: string[];
}

export function explainIr(parsed: ParsedFeature, file: string): IrExplanation {
  const m = buildDomainModel(parsed);
  const ir = buildIR(parsed, file);
  const english = !parsed.language || parsed.language === 'en';
  const declaredCommands = declaredTagValues(parsed, 'command');
  const declaredEvents = declaredTagValues(parsed, 'event');
  const quoted = parsed.scenarios.some(sc => sc.steps.some(st => /["'`][A-Z][A-Za-z0-9]*Command(?:Handler)?["'`]/.test(st.text)));
  const recognized = english && ir.commands.some(c => c.verb !== 'unknown');
  const commandSource: NameSource = declaredCommands.length ? 'tag' : quoted ? 'step identifier' : recognized ? 'English verb heuristic' : 'default';
  const eventSource: NameSource = declaredEvents.length ? 'tag' : ir.events.length ? 'step text' : 'default';
  const aggregateSource: NameSource = aggregateTagName(parsed.tags) ? 'tag' : 'feature name';

  const suggestions: string[] = [];
  if (aggregateSource !== 'tag') suggestions.push(`@aggregate:${m.pascal} keeps the aggregate name stable if the feature title changes.`);
  if (commandSource === 'default' || commandSource === 'English verb heuristic') {
    suggestions.push(`Declare the commands: ${m.commands.map(c => `@command:${c.name}`).join(' ')} (rename them to your domain's verbs).`);
  }
  if (eventSource !== 'tag') suggestions.push(`Declare the events: ${m.commands.map(c => `@event:${c.event}`).join(' ')}.`);

  return {
    feature: parsed.featureName,
    file,
    aggregate: { name: m.pascal, source: aggregateSource },
    route: `POST /api/v1/${m.kebab}/{id}/{command}`,
    commands: m.commands.map(c => ({ name: c.snake, event: c.event, source: commandSource })),
    events: m.events.map(name => ({ name, source: eventSource })),
    suggestions
  };
}

export function renderIrExplanation(x: IrExplanation): string {
  const lines = [
    `  IR of ${x.file} (${x.feature})`,
    `    aggregate  ${x.aggregate.name}  [${x.aggregate.source}]`,
    `    route      ${x.route}`,
    ...x.commands.map(c => `    command    ${c.name} -> ${c.event}  [${c.source}]`),
    ...(x.events.length ? x.events.map(e => `    event      ${e.name}  [${e.source}]`) : ['    event      (none named: each command emits <Command>Completed)']),
    ...x.suggestions.map(s => `    hint       ${s}`)
  ];
  return lines.join('\n');
}
