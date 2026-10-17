/* ==========================================================================
   gherkin-ai-cli - Industry profile registry

   `industry.id` in the config (or a legacy `domainProfile` alias such as
   "payments") selects a profile. The profile feeds:
   - ghk lint: its lint rules plus the common capability-depth rule;
   - the IR: compliance constraints and a governance policy;
   - prompts (ghk implement, agent prompts) and .ghe/industry-context.*.
   ========================================================================== */

import type { LintRule } from '../../specification-linter';
import type { GherkinAIConfig } from '../../config';
import { customRule, tagValues } from './lint-helpers';
import { industryProfileSchema, IndustryProfile } from './types';
import { INDUSTRY_IDS, IndustryId } from './ids';
import { generic } from './generic';
import { banking } from './banking';
import { telecom } from './telecom';
import { manufacturing } from './manufacturing';
import { health } from './health';
import { supplyChain } from './supply-chain';
import { insurance } from './insurance';
import { aviation } from './aviation';
import { automotive } from './automotive';

export type { IndustryProfile, IndustryProfileData, IndustryStandard, GlossaryEntry } from './types';
export { INDUSTRY_IDS, industryProfileSchema };
export type { IndustryId };

export const INDUSTRIES: Record<IndustryId, IndustryProfile> = {
  generic, banking, telecom, manufacturing, health,
  'supply-chain': supplyChain, insurance, aviation, automotive
};

/** Common to every industry: capability maps stop at L4 (MECE decomposition, BIAN / ACORD practice). */
export const CAPABILITY_DEPTH_RULE: LintRule = customRule({
  id: 'GHK090', name: 'Capability decomposition stops at L4', severity: 'error',
  check: (parsed, emit) => tagValues(parsed, 'capability')
    .filter(v => v.split('/').filter(Boolean).length > 4)
    .map(v => emit(`@capability:${v} has ${v.split('/').filter(Boolean).length} levels.`, { suggestion: 'Stop the capability tree at L4; anything deeper is process detail, not a capability.' }))
});

/** Resolves an industry id or alias ("fintech", "salud", ...). */
export function resolveIndustry(name?: string): IndustryProfile | undefined {
  if (!name) return undefined;
  const key = name.toLowerCase().trim();
  return Object.values(INDUSTRIES).find(p => p.id === key || p.aliases.includes(key));
}

/**
 * The industry a project declares in `industry.id`. A legacy `domainProfile` (e.g. "payments") never
 * activates one: industry rules add lint findings and approval paths, so they are opt-in.
 */
export function industryForConfig(config: Pick<GherkinAIConfig, 'industry' | 'domainProfile'>): IndustryProfile | undefined {
  return resolveIndustry(config.industry?.id);
}

/** The industry a legacy `domainProfile` suggests (for `ghk upgrade` / `ghk industry` hints). */
export function suggestedIndustry(config: Pick<GherkinAIConfig, 'industry' | 'domainProfile'>): IndustryProfile | undefined {
  return config.industry?.id ? undefined : resolveIndustry(config.domainProfile);
}

/** Lint rules contributed by the project industry (none when no industry is declared). */
export function industryLintRules(config: Pick<GherkinAIConfig, 'industry' | 'domainProfile'>): LintRule[] {
  const profile = industryForConfig(config);
  return profile ? [...profile.lintRules, CAPABILITY_DEPTH_RULE] : [];
}

/** `lintSpecification` options for a project: its industry rules minus `industry.disabledRules`. */
export function industryLintOptions(config: Pick<GherkinAIConfig, 'industry' | 'domainProfile'>): { rules: LintRule[]; disabledRules: string[] } {
  return { rules: industryLintRules(config), disabledRules: config.industry?.disabledRules ?? [] };
}

/** Lint rules of every industry (for `ghk lint --rules`). */
export function allIndustryLintRules(): LintRule[] {
  return [CAPABILITY_DEPTH_RULE, ...INDUSTRY_IDS.flatMap(id => INDUSTRIES[id].lintRules)];
}

/** Prompt section the LLM must follow (compact: one paragraph plus a pointer to the full context). */
export function renderIndustryGuidance(profile: IndustryProfile, options: { compact?: boolean; contextPath?: string } = {}): string {
  const header = `### 🏛️ Industry Standards: ${profile.label}`;
  const pointer = options.contextPath ? `\nFull rules, glossary and sources: @${options.contextPath}` : '';
  if (options.compact) return `${header}\n${profile.guidance.compact}${pointer}\n`;
  const standards = profile.standards.map(s => s.version ? `${s.name} ${s.version}` : s.name);
  const sections = [
    [header, ...(standards.length ? [`Standards: ${standards.join('; ')}.`] : []), `Canonical model: ${profile.canonicalModel}.`].join('\n'),
    ['MUST:', ...profile.guidance.rules.map(r => `- ${r}`)].join('\n'),
    profile.glossary.length ? `Vocabulary: ${profile.glossary.map(g => `${g.term} (not ${g.avoid.map(a => `"${a}"`).join('/')})`).join('; ')}.` : '',
    profile.compliance.length ? `Compliance reminders (engineering guidance, not certification): ${profile.compliance.join('; ')}.` : ''
  ];
  return `${sections.filter(Boolean).join('\n\n')}${pointer}\n`;
}

/** .ghe/industry-context.md: what the LLM and reviewers read for the project industry. */
export function renderIndustryContextMarkdown(profile: IndustryProfile): string {
  const rules = [...profile.lintRules, CAPABILITY_DEPTH_RULE];
  return `# Industry context: ${profile.label}

> Generated by gherkin-ai from the \`${profile.id}\` industry profile. Compliance items are engineering guidance, not legal advice or certification.

${profile.summary}

## Standards
${profile.standards.length ? profile.standards.map(s => `- **${s.name}**${s.version ? ` (${s.version})` : ''}: ${s.scope} <${s.url}>`).join('\n') : '- None (generic profile).'}

**Canonical model:** ${profile.canonicalModel}

## Rules the implementation must follow
${profile.guidance.rules.map(r => `- ${r}`).join('\n')}

## Vocabulary
${profile.glossary.length ? `| Use | Instead of | Meaning |\n|---|---|---|\n${profile.glossary.map(g => `| ${g.term} | ${g.avoid.join(', ')} | ${g.definition} |`).join('\n')}` : '- Use the ubiquitous language of the specification.'}

## Architecture
- Recommended architectures: ${profile.recommendedArchitectures.join(', ')}
- Recommended patterns: ${profile.recommendedPatterns.join(', ')}

## Specification tags
${profile.tagNamespaces.map(ns => `- \`@${ns}:<value>\``).join('\n')}

## Lint rules (ghk lint)
| Rule | Severity | Checks |
|---|---|---|
${rules.map(r => `| ${r.id} | ${r.severity} | ${r.name} |`).join('\n')}

## Compliance reminders
${profile.compliance.length ? profile.compliance.map(c => `- ${c}`).join('\n') : '- None specific to this profile.'}
${profile.approvalPaths.length ? `\nChanges under ${profile.approvalPaths.map(p => `\`${p}\``).join(', ')} require human approval (agent firewall).\n` : ''}`;
}

/** .ghe/industry-context.json: the machine-readable profile (schemas/industry-context.schema.json). */
export function renderIndustryContextJson(profile: IndustryProfile): string {
  const { lintRules, ...data } = profile;
  return JSON.stringify({
    ...industryProfileSchema.parse(data),
    lintRules: [...lintRules, CAPABILITY_DEPTH_RULE].map(r => ({ id: r.id, name: r.name, severity: r.severity }))
  }, null, 2) + '\n';
}
