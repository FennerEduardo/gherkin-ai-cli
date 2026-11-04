/* Types of the gherkin-ai plugin API 2, re-exported from the CLI's public entry (gherkin-ai/dist/plugin-api). */
import type {
  GherkinAIPlugin,
  SourceAnalyzer,
  LintRule,
  GatewayProvider
} from 'gherkin-ai/dist/plugin-api';

export type {
  GherkinAIPlugin,
  PluginContext,
  GeneratedArtifact,
  AnalysisContribution,
  ValidationResult,
  MCPToolDefinition,
  SourceAnalyzer,
  AnalysisContext,
  AnalyzerMaturity,
  SourceEvidence,
  EvidenceKind,
  EvidenceConfidence,
  EndpointMetadata,
  EntryMetadata,
  SourceLocationRange,
  SourceFile,
  LintRule,
  LintDiagnostic,
  LintOptions,
  ParsedFeature,
  GatewayProvider,
  GatewayProviderOptions,
  GatewayPlan,
  GatewayPlanItem,
  ProviderManifestView,
  ExposeControl,
  ControlSupport,
  GeneratedFile,
  PluginSdk
} from 'gherkin-ai/dist/plugin-api';

export declare const PLUGIN_API_VERSION: 2;
/** Returns the plugin unchanged, typed: `module.exports = definePlugin({ name, version, apiVersion: 2, … })`. */
export declare function definePlugin<T extends GherkinAIPlugin>(plugin: T & { apiVersion: 2 }): T;
export declare function defineAnalyzer<T extends SourceAnalyzer>(analyzer: T): T;
export declare function defineLintRule<T extends LintRule>(rule: T): T;
export declare function defineGatewayProvider<T extends GatewayProvider>(provider: T): T;
