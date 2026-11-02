/* ==========================================================================
   gherkin-ai-cli - tree-sitter loader for `ghk reverse` (PLAN-3.3.0 R-06)

   web-tree-sitter (pinned 0.25.10: the newest release that loads these
   grammars) with the five grammars vendored in vendor/tree-sitter/ (Java,
   Kotlin, C#, Python, Go; see its NOTICE.md). Everything is loaded lazily,
   on the first file of that language `ghk reverse` reads: nothing here runs
   at CLI start-up.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import type { Language as TSLanguage, Node as TSNode, Parser as TSParser, Tree } from 'web-tree-sitter';

export type { TSNode, Tree };
export type GrammarId = 'java' | 'kotlin' | 'c_sharp' | 'python' | 'go';

/** vendor/tree-sitter, found upwards from this file (src/… in tests, dist/… when installed). */
export function grammarDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'vendor', 'tree-sitter');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('vendor/tree-sitter not found: the gherkin-ai package is incomplete.');
}

let runtime: Promise<{ Parser: typeof TSParser; Language: typeof TSLanguage }> | undefined;
const languages = new Map<GrammarId, Promise<TSLanguage>>();

async function loadRuntime() {
  runtime ??= (async () => {
    const mod = await import('web-tree-sitter');
    await mod.Parser.init();
    return { Parser: mod.Parser, Language: mod.Language };
  })();
  return runtime;
}

/** A parser for one grammar; parse with `parser.parse(text)`. */
export async function parserFor(id: GrammarId): Promise<TSParser> {
  const { Parser, Language } = await loadRuntime();
  let lang = languages.get(id);
  if (!lang) {
    lang = Language.load(path.join(grammarDir(), `tree-sitter-${id}.wasm`));
    languages.set(id, lang);
  }
  const parser = new Parser();
  parser.setLanguage(await lang);
  return parser;
}

// ---------------------------------------------------------------------------
// Walking helpers (grammar-agnostic)
// ---------------------------------------------------------------------------

export function* walk(node: TSNode): Generator<TSNode> {
  yield node;
  for (const child of node.namedChildren) if (child) yield* walk(child);
}

export const ofType = (node: TSNode, ...types: string[]) => [...walk(node)].filter(n => types.includes(n.type));

export const childOfType = (node: TSNode | null | undefined, ...types: string[]): TSNode | undefined =>
  node?.namedChildren.find((c): c is TSNode => Boolean(c) && types.includes(c!.type));

export const childrenOfType = (node: TSNode | null | undefined, ...types: string[]): TSNode[] =>
  (node?.namedChildren ?? []).filter((c): c is TSNode => Boolean(c) && types.includes(c!.type));

/** First ancestor of one of the types, without leaving `stop`. */
export function ancestor(node: TSNode, stop: TSNode | undefined, ...types: string[]): TSNode | undefined {
  for (let n = node.parent; n && n.id !== stop?.id; n = n.parent) if (types.includes(n.type)) return n;
  return undefined;
}

/**
 * The text of a string literal without quotes (Java, Kotlin, C#, Python, Go). Interpolated strings
 * (Kotlin `"$x"` / `"${x}"`, Python f-strings, C# `$"…"`, Ruby `#{…}`) return undefined: their value is not
 * known statically. Plain braces are kept: `"/{id}/cancel"` is a route template.
 */
export function unquote(text: string): string | undefined {
  const m = text.match(/^([rbfuRBFU$]{0,2})?(?:"""([\s\S]*)"""|'''([\s\S]*)'''|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`|@"((?:[^"]|"")*)")$/);
  if (!m) return undefined;
  if (/[fF$]/.test(m[1] ?? '')) return undefined;
  const v = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7];
  return v !== undefined && !/\$\{|\$[A-Za-z_]|#\{/.test(v) ? v : undefined;
}

export const lineRange = (node: TSNode) => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
