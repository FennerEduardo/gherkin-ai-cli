/* ==========================================================================
   gherkin-ai-cli - Small HCL rendering helpers for the Terraform modules
   ========================================================================== */

/** An HCL string literal ("${" and "%{" are escaped so values are never interpolated). */
export const hstr = (s: string) => JSON.stringify(s).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');

/** An HCL list of strings. */
export const hlist = (items: string[]) => `[${items.map(hstr).join(', ')}]`;

/** An HCL object with aligned "=" (terraform fmt style), indented by `indent` spaces. */
export function hmap(entries: Record<string, string>, indent: number, quoteKeys = false): string {
  const keys = Object.keys(entries);
  if (!keys.length) return '{}';
  const key = (k: string) => (quoteKeys || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? hstr(k) : k);
  const width = Math.max(...keys.map(k => key(k).length));
  const pad = ' '.repeat(indent);
  return `{\n${keys.map(k => `${pad}  ${key(k).padEnd(width)} = ${entries[k]}`).join('\n')}\n${pad}}`;
}

/** Aligned `name = value` lines (terraform fmt style). */
export function hattrs(attrs: [string, string][], indent: number): string {
  const width = Math.max(...attrs.map(([k]) => k.length));
  return attrs.map(([k, v]) => `${' '.repeat(indent)}${k.padEnd(width)} = ${v}`).join('\n');
}

/** Terraform-safe identifier for a database name (letters, digits, underscores). */
export const dbIdentifier = (name: string) => name.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 48) || 'app';
