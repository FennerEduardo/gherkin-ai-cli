/* ==========================================================================
   gherkin-ai-cli - Building blocks for industry lint rules

   Every rule is deterministic and reads only the parsed specification:
   tags (@bian:PaymentExecution), scenario names and step text. Step text is
   matched without its quoted example values unless a rule says otherwise.
   Keyword lists cover English and Spanish specifications.
   ========================================================================== */

import type { LintDiagnostic, LintRule, LintSeverity } from '../../specification-linter';
import type { ParsedFeature, ScenarioModel } from '../../gherkin-parser';
import { withoutQuotedText } from '../../../utils/quoted-text';
import type { GlossaryEntry } from './types';

interface RuleBase {
  id: string;
  name: string;
  severity: LintSeverity;
}

const unique = <T>(xs: T[]) => Array.from(new Set(xs));

/** Values of the `@<ns>:<value>` tags on the feature and its scenarios (case-insensitive namespace). */
export function tagValues(parsed: ParsedFeature, ns: string): string[] {
  const prefix = `@${ns.toLowerCase()}:`;
  const tags = [...parsed.tags, ...parsed.scenarios.flatMap(s => s.tags)];
  return unique(tags.filter(t => t.toLowerCase().startsWith(prefix)).map(t => t.slice(prefix.length)).filter(Boolean));
}

/** Scenario name and step text (quoted values blanked unless `raw`), background included. */
export function scenarioText(parsed: ParsedFeature, s: ScenarioModel, raw = false): string {
  const steps = [...(parsed.background?.steps || []), ...s.steps].map(st => raw ? st.text : withoutQuotedText(st.text));
  return [s.name, ...steps].join('\n');
}

export function featureText(parsed: ParsedFeature, raw = false): string {
  return [parsed.featureName, ...parsed.descriptionLines, ...parsed.scenarios.map(s => scenarioText(parsed, s, raw))].join('\n');
}

const diag = (rule: RuleBase, message: string, extra: Partial<LintDiagnostic> = {}): LintDiagnostic =>
  ({ ruleId: rule.id, severity: rule.severity, message, ...extra });

/**
 * The feature must carry at least one `@<ns>:<value>` tag; when `format` is given, every value must match it.
 */
export function requireTag(rule: RuleBase & { ns: string; format?: RegExp; example: string; why: string }): LintRule {
  return {
    ...rule,
    check: parsed => {
      const values = tagValues(parsed, rule.ns);
      if (values.length === 0) {
        return [diag(rule, `Feature declares no @${rule.ns}:<...> tag. ${rule.why}`, { suggestion: `Tag the feature, e.g. ${rule.example}.` })];
      }
      return values
        .filter(v => rule.format && !rule.format.test(v))
        .map(v => diag(rule, `@${rule.ns}:${v} is not a valid value.`, { suggestion: `Use the standard form, e.g. ${rule.example}.` }));
    }
  };
}

/** At most one distinct `@<ns>:<value>` across the feature (e.g. one BIAN service domain per API). */
export function singleTagValue(rule: RuleBase & { ns: string; why: string }): LintRule {
  return {
    ...rule,
    check: parsed => {
      const values = tagValues(parsed, rule.ns);
      return values.length > 1
        ? [diag(rule, `Feature spans ${values.length} @${rule.ns} values (${values.join(', ')}). ${rule.why}`, { suggestion: 'Split the feature so each one maps to a single value.' })]
        : [];
    }
  };
}

/** Flags non-canonical synonyms in step text (whole words, outside quoted values). */
export function glossaryRule(rule: RuleBase & { entries: GlossaryEntry[] }): LintRule {
  return {
    ...rule,
    check: parsed => {
      const diags: LintDiagnostic[] = [];
      const seen = new Set<string>();
      for (const s of parsed.scenarios) {
        for (const step of s.steps) {
          const text = withoutQuotedText(step.text).toLowerCase();
          for (const entry of rule.entries) {
            for (const word of entry.avoid) {
              const key = `${word}->${entry.term}`;
              if (seen.has(key) || !new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(word)}($|[^\\p{L}\\p{N}])`, 'u').test(text)) continue;
              seen.add(key);
              diags.push(diag(rule, `"${word}" is not the canonical term.`, { scenario: s.name, step: step.text, suggestion: `Use "${entry.term}": ${entry.definition}` }));
            }
          }
        }
      }
      return diags;
    }
  };
}

/**
 * Scenarios (or the feature, with scope 'feature') whose text matches `when` must also match `require`.
 */
export function requireCompanion(rule: RuleBase & { when: RegExp; require: RegExp; scope?: 'scenario' | 'feature'; message: string; suggestion: string }): LintRule {
  return {
    ...rule,
    check: parsed => {
      if (rule.scope === 'feature') {
        const text = featureText(parsed);
        return rule.when.test(text) && !rule.require.test(text) ? [diag(rule, rule.message, { suggestion: rule.suggestion })] : [];
      }
      return parsed.scenarios
        .filter(s => rule.when.test(scenarioText(parsed, s)) && !rule.require.test(scenarioText(parsed, s)))
        .map(s => diag(rule, rule.message, { scenario: s.name, line: s.line, suggestion: rule.suggestion }));
    }
  };
}

/** Flags steps matching `pattern` (with `raw`, quoted values are searched too). */
export function forbidPattern(rule: RuleBase & { pattern: RegExp; raw?: boolean; message: string; suggestion: string }): LintRule {
  return {
    ...rule,
    check: parsed => parsed.scenarios.flatMap(s => s.steps
      .filter(st => rule.pattern.test(rule.raw ? st.text : withoutQuotedText(st.text)))
      .map(st => diag(rule, rule.message, { scenario: s.name, step: st.text, suggestion: rule.suggestion })))
  };
}

/** A rule whose diagnostics come from a custom check over the parsed feature. */
export function customRule(rule: RuleBase & { check: (parsed: ParsedFeature, emit: (message: string, extra?: Partial<LintDiagnostic>) => LintDiagnostic) => LintDiagnostic[] }): LintRule {
  return {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    check: parsed => rule.check(parsed, (message, extra) => diag(rule, message, extra))
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
