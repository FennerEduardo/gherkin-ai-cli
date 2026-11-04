/* ==========================================================================
   gherkin-ai - The public plugin API (PLAN-3.3.0-reverse-plus EC-02)

   The one module plugin authors (and @gherkin-ai/plugin-sdk) import types
   from: `gherkin-ai/dist/plugin-api`. Everything else under dist/ is
   internal and may change in any release; this module changes only with
   the plugin API version.
   ========================================================================== */

export { PLUGIN_API_VERSION, satisfiesRange } from './core/plugins/compat';
export type { GherkinAIPlugin, PluginContext, GeneratedArtifact, AnalysisContribution, ValidationResult, MCPToolDefinition } from './core/plugin-system';
export type { SourceAnalyzer, AnalysisContext, AnalyzerMaturity } from './core/reverse/registry';
export type { SourceEvidence, EvidenceKind, EvidenceConfidence, EndpointMetadata, EntryMetadata, SourceLocationRange } from './core/reverse/evidence';
export type { SourceFile } from './core/reverse/discovery';
export type { LintRule, LintDiagnostic, LintOptions } from './core/specification-linter';
export type { ParsedFeature } from './core/parsers/specification-interface';
export type { GatewayProvider, GatewayProviderOptions, GatewayPlan, GatewayPlanItem, ProviderManifestView, ExposeControl, ControlSupport, GeneratedFile } from './core/expose/provider-types';
export type { PluginSdk } from './core/plugins/sdk';
