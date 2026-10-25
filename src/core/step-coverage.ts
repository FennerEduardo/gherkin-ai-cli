/* ==========================================================================
   gherkin-ai-cli - Steps of a feature that no step definition matches

   `ghk validate -f <feature>` (E-11): a step nobody implements fails at run
   time as "undefined" (or is silently pending); this finds it statically.
   Step definitions come from the step indexer (TypeScript/JavaScript AST,
   Java/Kotlin annotations, Python decorators, C# attributes, Ruby blocks),
   generated skeletons included: a pending step is still a definition.
   Patterns are Cucumber expressions or regular expressions.
   ========================================================================== */

import type { ExtractedStep } from './step-indexer';

const PARAMETER: Record<string, string> = {
  int: '-?\\d+',
  float: '-?\\d*[.,]?\\d+',
  word: '[^\\s]+',
  string: '(?:"[^"]*"|\'[^\']*\')',
  bigdecimal: '-?\\d*[.,]?\\d+',
  double: '-?\\d*[.,]?\\d+',
  long: '-?\\d+',
  byte: '-?\\d+',
  short: '-?\\d+',
  biginteger: '-?\\d+',
  '': '.*'
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A step pattern as a RegExp: a regular expression as written, or a Cucumber expression converted. */
export function stepPatternToRegExp(pattern: string): RegExp | undefined {
  const p = pattern.trim();
  try {
    if (p.startsWith('/') && p.lastIndexOf('/') > 0) return new RegExp(p.slice(1, p.lastIndexOf('/')), p.slice(p.lastIndexOf('/') + 1).replace(/[^imsu]/g, ''));
    if (p.startsWith('^') || p.endsWith('$') || /\\[dwsS]|\(\?|\[\^?[^\]]*\]|\.\*|\.\+/.test(p)) return new RegExp(p.startsWith('^') ? p : `^${p}`);
    // Cucumber expression: {parameter}, (optional text), alternative/words.
    let re = '';
    const tokens = p.match(/\{[^}]*\}|\([^)]*\)|[^\s{(]+|\s+/g) ?? [];
    for (const t of tokens) {
      if (t.startsWith('{')) re += PARAMETER[t.slice(1, -1).toLowerCase()] ?? '.+';
      else if (t.startsWith('(')) re += `(?:${escape(t.slice(1, -1))})?`;
      else if (/^\s+$/.test(t)) re += '\\s+';
      else if (t.includes('/') && !t.startsWith('/')) re += `(?:${t.split('/').map(escape).join('|')})`;
      else re += escape(t);
    }
    return new RegExp(`^${re}$`);
  } catch {
    return undefined;
  }
}

/**
 * Steps (keyword + text) that no definition matches. Undefined when there are no definitions at all (the
 * check does not apply: nothing is implemented yet). Outline steps with <placeholders> are not checked.
 */
export function undefinedSteps(steps: { keyword: string; text: string }[], definitions: ExtractedStep[]): string[] | undefined {
  const patterns = definitions.map(d => stepPatternToRegExp(d.pattern)).filter((r): r is RegExp => r !== undefined);
  if (!patterns.length) return undefined;
  const missing = new Set<string>();
  for (const step of steps) {
    const text = step.text.split('\n')[0].trim();
    if (!text || /<[^>]+>/.test(text)) continue;
    if (!patterns.some(re => re.test(text))) missing.add(`${step.keyword.trim()} ${text}`);
  }
  return [...missing];
}
