/* ==========================================================================
   gherkin-ai-cli - Identifier naming

   The single place where feature / step names become identifiers. Every
   generator must use these so that files emitted by different generators
   agree on type names (e.g. "Creación de Pedidos" -> CreacionDePedidos).
   ========================================================================== */

const words = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // Creación -> Creacion, Ñandú -> Nandu
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2') // YRenderizado -> Y Renderizado
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

export const toPascal = (s: string) => words(s).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'App';
export const toCamel = (s: string) => { const p = toPascal(s); return p.charAt(0).toLowerCase() + p.slice(1); };
export const toSnake = (s: string) => words(s).map(w => w.toLowerCase()).join('_') || 'app';
export const toKebab = (s: string) => words(s).map(w => w.toLowerCase()).join('-') || 'app';
export const toFlat = (s: string) => words(s).map(w => w.toLowerCase()).join('') || 'app';

/** Prefixes `fallback` when `raw` does not start with a letter (identifiers cannot start with a digit). */
export function safeIdent(raw: string, fallback: string): string {
  return /^[A-Za-z]/.test(raw) ? raw : `${fallback}${raw}`;
}

/** Canonical PascalCase type name for a feature: the aggregate / entity / contract prefix in every stack. */
export function featurePascalName(featureName: string | undefined): string {
  return safeIdent(toPascal(featureName || 'App'), 'Feature');
}
