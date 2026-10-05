/* ==========================================================================
   gherkin-ai-cli - GitHub Spec Kit interoperability

   Spec Kit keeps one folder per feature (specs/NNN-name/spec.md, or
   .specify/specs/ in older layouts) whose spec.md has user stories with
   "Given / When / Then" acceptance scenarios and FR-### functional
   requirements. gherkin-ai sits below it as the executable, verifiable layer:

     import:  spec.md  → .feature  (one scenario per acceptance scenario,
              tagged @US<n> @P<n>; FRs and edge cases kept in the description)
     export:  .feature → spec.md   (round-trips the @US grouping)
   ========================================================================== */

import { toKebab } from '../../utils/naming';
import type { ParsedFeature } from '../parsers/specification-interface';

export interface SpecKitScenario {
  given: string[];
  when: string[];
  then: string[];
}

export interface SpecKitStory {
  index: number;
  title: string;
  priority?: string;
  narrative: string[];
  scenarios: SpecKitScenario[];
}

export interface SpecKitSpec {
  title: string;
  branch?: string;
  input?: string;
  stories: SpecKitStory[];
  requirements: { id: string; text: string }[];
  edgeCases: string[];
  successCriteria: { id: string; text: string }[];
  /** [NEEDS CLARIFICATION: ...] markers found anywhere in the spec. */
  clarifications: string[];
}

const strip = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

/** Splits "**Given** a, **When** b, **Then** c and d" into clauses. */
export function parseAcceptanceScenario(line: string): SpecKitScenario | undefined {
  const text = line.replace(/^\s*(\d+\.|[-*])\s*/, '');
  const parts = text.split(/\*\*(Given|When|Then|And|But)\*\*/i);
  if (parts.length < 3) return undefined;
  const scenario: SpecKitScenario = { given: [], when: [], then: [] };
  let current: keyof SpecKitScenario = 'given';
  for (let i = 1; i < parts.length; i += 2) {
    const keyword = parts[i].toLowerCase();
    const clause = parts[i + 1].trim().replace(/^[,;:]\s*/, '').replace(/[,;.]\s*$/, '').trim();
    if (keyword === 'given' || keyword === 'when' || keyword === 'then') current = keyword;
    if (clause) scenario[current].push(clause);
  }
  return scenario.when.length || scenario.then.length ? scenario : undefined;
}

export function parseSpecKitSpec(markdown: string): SpecKitSpec {
  const spec: SpecKitSpec = { title: 'Untitled feature', stories: [], requirements: [], edgeCases: [], successCriteria: [], clarifications: [] };
  let section = '';
  let story: SpecKitStory | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    for (const m of line.matchAll(/\[NEEDS CLARIFICATION:?\s*([^\]]*)\]/gi)) spec.clarifications.push(m[1].trim());
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#\s+(?:Feature Specification:\s*)?(.+)$/))) {
      spec.title = strip(m[1]);
      continue;
    }
    if ((m = line.match(/^\*\*Feature Branch\*\*:\s*(.+)$/))) spec.branch = strip(m[1]);
    if ((m = line.match(/^\*\*Input\*\*:\s*(?:User description:\s*)?(.+)$/))) spec.input = strip(m[1]).replace(/^"|"$/g, '');
    if ((m = line.match(/^##\s+(.+)$/))) {
      section = m[1].toLowerCase();
      story = undefined;
      continue;
    }
    if ((m = line.match(/^###\s+(.+)$/))) {
      const heading = strip(m[1]);
      const us = heading.match(/^User Story\s+(\d+)\s*[-–—:]\s*(.+?)(?:\s*\(Priority:\s*(P\d+)\))?$/i);
      if (us) {
        story = { index: Number(us[1]), title: us[2].trim(), priority: us[3], narrative: [], scenarios: [] };
        spec.stories.push(story);
      } else {
        story = undefined;
        section = heading.toLowerCase();
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (story) {
      const scenario = parseAcceptanceScenario(trimmed);
      if (scenario) story.scenarios.push(scenario);
      else if (!/^\*\*(Why this priority|Independent Test|Acceptance Scenarios)\*\*/i.test(trimmed)) story.narrative.push(strip(trimmed));
      continue;
    }
    if ((m = trimmed.match(/^[-*]\s*\*\*(FR-\d+)\*\*:?\s*(.+)$/))) spec.requirements.push({ id: m[1], text: strip(m[2]) });
    else if ((m = trimmed.match(/^[-*]\s*\*\*(SC-\d+)\*\*:?\s*(.+)$/))) spec.successCriteria.push({ id: m[1], text: strip(m[2]) });
    else if (/edge cases/.test(section) && /^[-*]\s+/.test(trimmed)) spec.edgeCases.push(strip(trimmed.replace(/^[-*]\s+/, '')));
  }
  return spec;
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toLowerCase() + t.slice(1);
};

/** Renders a .feature file from a Spec Kit spec. */
export function specKitToFeature(spec: SpecKitSpec): string {
  const lines: string[] = ['@speckit'];
  lines.push(`Feature: ${spec.title}`);
  if (spec.input) lines.push(`  ${spec.input}`);
  if (spec.requirements.length) {
    lines.push('');
    lines.push('  Functional requirements (Spec Kit):');
    for (const r of spec.requirements) lines.push(`    ${r.id}: ${r.text}`);
  }
  if (spec.edgeCases.length) {
    lines.push('');
    lines.push('  Edge cases to specify:');
    for (const e of spec.edgeCases) lines.push(`    - ${e}`);
  }
  for (const story of spec.stories) {
    story.scenarios.forEach((scenario, i) => {
      lines.push('');
      lines.push(`  @US${story.index}${story.priority ? ` @${story.priority}` : ''}`);
      lines.push(`  Scenario: ${story.title}${story.scenarios.length > 1 ? ` (${i + 1})` : ''}`);
      const emit = (keyword: string, clauses: string[]) => clauses.forEach((c, j) => lines.push(`    ${j === 0 ? keyword : 'And'} ${sentence(c)}`));
      emit('Given', scenario.given);
      emit('When', scenario.when);
      emit('Then', scenario.then);
    });
  }
  return lines.join('\n') + '\n';
}

const clean = (tag: string) => tag.replace(/^@/, '');

/** Renders a Spec Kit spec.md from a parsed .feature file. */
export function featureToSpecKit(feature: ParsedFeature, options: { branch?: string; date?: string } = {}): string {
  const stories = new Map<string, { title: string; priority: string; scenarios: ParsedFeature['scenarios'] }>();
  for (const scenario of feature.scenarios) {
    const tags = scenario.tags.map(clean);
    const us = tags.find(t => /^US\d+$/i.test(t));
    const priority = tags.find(t => /^P\d+$/i.test(t)) ?? 'P1';
    const key = us ?? `US${stories.size + 1}`;
    if (!stories.has(key)) stories.set(key, { title: scenario.name.replace(/\s*\(\d+\)$/, ''), priority, scenarios: [] });
    stories.get(key)!.scenarios.push(scenario);
  }

  const requirements = feature.descriptionLines.map(l => l.trim().match(/^(FR-\d+):\s*(.+)$/)).filter((m): m is RegExpMatchArray => Boolean(m));
  const narrative = feature.descriptionLines.map(l => l.trim()).filter(l => l && !/^(FR-\d+:|- |Functional requirements|Edge cases)/.test(l));
  const out: string[] = [
    `# Feature Specification: ${feature.featureName}`,
    '',
    `**Feature Branch**: \`${options.branch ?? toKebab(feature.featureName)}\``,
    `**Created**: ${options.date ?? new Date().toISOString().slice(0, 10)}`,
    '**Status**: Draft',
    `**Input**: User description: "${narrative.join(' ') || feature.featureName}"`,
    '',
    '## User Scenarios & Testing *(mandatory)*',
    ''
  ];
  let n = 0;
  for (const story of stories.values()) {
    n++;
    out.push(`### User Story ${n} - ${story.title} (Priority: ${story.priority})`, '', '**Acceptance Scenarios**:', '');
    story.scenarios.forEach((scenario, i) => {
      const clauses: string[] = [];
      let last = 'Given';
      for (const step of scenario.steps) {
        const keyword = step.keyword === 'And' || step.keyword === 'But' ? 'And' : step.keyword;
        if (keyword !== 'And') last = keyword;
        clauses.push(`**${keyword === 'And' && clauses.length === 0 ? last : keyword}** ${step.text}`);
      }
      out.push(`${i + 1}. ${clauses.join(', ')}`);
    });
    out.push('', '---', '');
  }
  out.push('## Requirements *(mandatory)*', '', '### Functional Requirements', '');
  if (requirements.length) for (const m of requirements) out.push(`- **${m[1]}**: ${m[2]}`);
  else feature.scenarios.forEach((s, i) => out.push(`- **FR-${String(i + 1).padStart(3, '0')}**: System MUST support: ${s.name}`));
  out.push('', '## Success Criteria *(mandatory)*', '', '### Measurable Outcomes', '');
  out.push(`- **SC-001**: Every acceptance scenario passes as an executable test (\`ghk verify\`) and the implementation converges with the specification (\`ghk converge\`).`);
  return out.join('\n') + '\n';
}
