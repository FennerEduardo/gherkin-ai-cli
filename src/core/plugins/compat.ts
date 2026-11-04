/* ==========================================================================
   gherkin-ai-cli - Plugin compatibility (PLAN-3.3.0-reverse-plus EC-01)

   A plugin declares the API it was written for (`apiVersion`) and the
   gherkin-ai versions it supports (`engines["gherkin-ai"]`, an npm-style
   range). An incompatible plugin is refused with a clear error when it is
   registered, never half-loaded. The range syntax is the common subset of
   npm's: `*`, `3`, `3.3`, `3.3.0`, `^3.3`, `~3.3.1`, `>=3.3 <4`, and `||`.
   ========================================================================== */

/** The plugin API this CLI implements. v1 plugins (no apiVersion) keep working. */
export const PLUGIN_API_VERSION = 2;

const parse = (v: string): [number, number, number] => {
  const [a = '0', b = '0', c = '0'] = v.replace(/^v/, '').split(/[-+]/)[0].split('.');
  return [Number(a) || 0, Number(b) || 0, Number(c) || 0];
};
const cmp = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function satisfiesOne(version: [number, number, number], comparator: string): boolean {
  const c = comparator.trim();
  if (!c || c === '*' || c === 'x') return true;
  const m = c.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return false;
  const op = m[1] ?? '';
  const parts = [m[2], m[3], m[4]];
  const defined = parts.filter(p => p !== undefined && p !== 'x' && p !== '*').length;
  const base = parse(parts.map(p => (p === undefined || p === 'x' || p === '*' ? '0' : p)).join('.'));
  if (op === '^') {
    const upper: [number, number, number] = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return cmp(version, base) >= 0 && cmp(version, upper) < 0;
  }
  if (op === '~') {
    const upper: [number, number, number] = defined >= 2 ? [base[0], base[1] + 1, 0] : [base[0] + 1, 0, 0];
    return cmp(version, base) >= 0 && cmp(version, upper) < 0;
  }
  if (op === '>=') return cmp(version, base) >= 0;
  if (op === '>') return cmp(version, base) > 0;
  if (op === '<=') return cmp(version, base) <= 0;
  if (op === '<') return cmp(version, base) < 0;
  // `3`, `3.3`, `3.3.0`, `=3.3.0`: equal on the parts given.
  return parts.slice(0, defined).every((_, i) => version[i] === base[i]);
}

/** Does `version` satisfy the npm-style `range`? */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parse(version);
  return range.split('||').some(alt => alt.trim().split(/\s+/).filter(Boolean).every(c => satisfiesOne(v, c)) || alt.trim() === '');
}

export interface CompatibilityProblem {
  plugin: string;
  reason: string;
}

/** Why a plugin cannot run on this CLI, or undefined when it can. */
export function incompatibility(plugin: { name: string; apiVersion?: number; engines?: Record<string, string> }, cliVersion: string): CompatibilityProblem | undefined {
  const api = plugin.apiVersion ?? 1;
  if (!Number.isInteger(api) || api < 1) return { plugin: plugin.name, reason: `apiVersion ${String(plugin.apiVersion)} is not a plugin API version` };
  if (api > PLUGIN_API_VERSION) return { plugin: plugin.name, reason: `it needs plugin API ${api}; gherkin-ai ${cliVersion} implements ${PLUGIN_API_VERSION}. Upgrade gherkin-ai or use an older version of the plugin.` };
  const range = plugin.engines?.['gherkin-ai'];
  if (range && !satisfiesRange(cliVersion, range)) return { plugin: plugin.name, reason: `it supports gherkin-ai ${range}; this is ${cliVersion}.` };
  return undefined;
}
