/* ==========================================================================
   gherkin-ai-cli - Helpers the CLI hands to plugin analyzers
   (PLAN-3.3.0-reverse-plus EC-02)

   Every `SourceAnalyzer` receives `ctx.sdk`. A plugin builds its evidence
   with the same functions the built-in analyzers use, so ids are stable
   (two runs, the same ids: review decisions survive a rescan) and paths
   are normalised the same way. `loadGrammar` parses with the CLI's own
   web-tree-sitter, so a plugin ships only its `.wasm` grammar and needs no
   runtime dependency. The SDK package (@gherkin-ai/plugin-sdk) carries the
   types of this object and of the plugin API.
   ========================================================================== */

import { isTestFile } from '../reverse/discovery';
import { evidenceId, joinPaths, makeEvidence, normalisePath } from '../reverse/evidence';
import { childOfType, childrenOfType, lineRange, ofType, parserForWasm, unquote } from '../reverse/analyzers/treesitter/loader';

export const pluginSdk = {
  makeEvidence,
  evidenceId,
  normalisePath,
  joinPaths,
  isTestFile,
  /** A tree-sitter parser for the plugin's own grammar file (absolute path, or relative to the plugin). */
  loadGrammar: parserForWasm,
  /** Grammar-agnostic tree helpers, as the built-in analyzers use them. */
  tree: { ofType, childOfType, childrenOfType, lineRange, unquote }
};

export type PluginSdk = typeof pluginSdk;
