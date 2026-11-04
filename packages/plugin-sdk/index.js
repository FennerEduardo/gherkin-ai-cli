'use strict';
/* @gherkin-ai/plugin-sdk: the runtime part is deliberately tiny. The CLI hands every analyzer its helpers in
   `ctx.sdk` (evidence ids, paths, tree-sitter), so a plugin has no runtime dependency on this package beyond these
   identity functions, which only give editors the types. */

/** Plugin API version this SDK describes. */
exports.PLUGIN_API_VERSION = 2;

/** Returns the plugin unchanged; typed as a GherkinAIPlugin of API 2. */
exports.definePlugin = plugin => plugin;
exports.defineAnalyzer = analyzer => analyzer;
exports.defineLintRule = rule => rule;
exports.defineGatewayProvider = provider => provider;
