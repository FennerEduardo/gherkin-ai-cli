import path from 'path';
import { SpecificationIR } from './semantic-ir';
import { ConfigError, PolicyError } from './errors';
import { getTelemetry } from './telemetry';
import { assertPathInside } from '../utils/path-guard';
import { GherkinAIConfig } from './config';
import { Constitution } from './constitution';
import type { SourceAnalyzer } from './reverse/registry';
import type { LintRule } from './specification-linter';
import type { GatewayProvider } from './expose/provider-types';
import { incompatibility } from './plugins/compat';
import { CLI_VERSION } from '../version';

export interface PluginContext {
  config: GherkinAIConfig;
  constitution: Constitution | null;
  projectDir: string;
}

export interface GeneratedArtifact {
  filePath: string;
  content: string;
  type: 'contract' | 'fixture' | 'openapi' | 'test' | 'prompt' | 'config' | 'other';
}

export interface AnalysisContribution {
  warnings?: string[];
  recommendations?: string[];
  injectedMetadata?: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
}

export interface GherkinAIPlugin {
  name: string;
  version: string;
  /**
   * The plugin API it is written for (PLAN-3.3.0-reverse-plus EC-01). Absent means 1: the generation, validation and
   * MCP hooks below. Version 2 adds the extension points `reverseAnalyzers`, `lintRules` and `gatewayProviders`.
   */
  apiVersion?: 1 | 2;
  /** npm-style range of the gherkin-ai versions it supports: `{ "gherkin-ai": "^3.3" }`. */
  engines?: { 'gherkin-ai'?: string };

  // API 2: extension points.
  /** Reverse-engineering analyzers (`ghk reverse scan`), each with its id, maturity and detect/analyze. */
  reverseAnalyzers?(): SourceAnalyzer[];
  /** Lint rules added to `ghk lint` and to the lint of reverse proposals. */
  lintRules?(): LintRule[];
  /** Gateway providers for `ghk expose` (Azure API Management, Google Cloud, …). */
  gatewayProviders?(): GatewayProvider[];

  // Lifecycle hooks
  onInit?(context: PluginContext): void;
  
  // Analysis phase
  analyze?(ir: SpecificationIR): AnalysisContribution;
  
  // Generation phase
  generate?(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[];
  
  // Validation phase
  validate?(artifacts: GeneratedArtifact[]): ValidationResult;
  
  // MCP tools
  mcpTools?(): MCPToolDefinition[];
}

export class PluginRegistry {
  private plugins: GherkinAIPlugin[] = [];
  private context: PluginContext | null = null;
  private readonly loadedSpecifiers = new Set<string>();

  public initialize(context: PluginContext): void {
    this.context = context;
    for (const plugin of this.plugins) {
      if (plugin.onInit) {
        plugin.onInit(context);
      }
    }
  }

  public register(plugin: GherkinAIPlugin): void {
    // Avoid duplicates
    if (this.plugins.some(p => p.name === plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already registered.`);
    }
    // A plugin written for another API or another gherkin-ai is refused here, before any of its hooks runs.
    const problem = incompatibility(plugin, CLI_VERSION);
    if (problem) throw new ConfigError(`Plugin "${plugin.name}" cannot be loaded: ${problem.reason}`);
    this.plugins.push(plugin);
    if (this.context && plugin.onInit) {
      plugin.onInit(this.context);
    }
  }

  public getPlugins(): GherkinAIPlugin[] {
    return [...this.plugins];
  }

  public runAnalysis(ir: SpecificationIR): AnalysisContribution[] {
    const results: AnalysisContribution[] = [];
    for (const plugin of this.plugins) {
      if (plugin.analyze) {
        results.push(plugin.analyze(ir));
      }
    }
    return results;
  }

  public runGeneration(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const artifacts: GeneratedArtifact[] = [];
    for (const plugin of this.plugins) {
      if (plugin.generate) {
        const generated = plugin.generate(ir, config);
        if (generated && Array.isArray(generated)) {
          artifacts.push(...generated);
        }
      }
    }
    return artifacts;
  }

  public runValidation(artifacts: GeneratedArtifact[]): ValidationResult[] {
    const results: ValidationResult[] = [];
    for (const plugin of this.plugins) {
      if (plugin.validate) {
        results.push(plugin.validate(artifacts));
      }
    }
    return results;
  }

  /**
   * Loads the plugins listed in `plugins.load`. Enforces the organization allow-list
   * (`plugins.allow`), keeps relative paths inside the project and audits every load.
   * A module must export a GherkinAIPlugin (default or `plugin`) or `register(registry)`.
   */
  public loadFromConfig(config: GherkinAIConfig, projectDir: string = process.cwd()): string[] {
    const requested = config.plugins?.load ?? [];
    const allow = config.plugins?.allow;
    const loaded: string[] = [];
    const telemetry = getTelemetry();

    for (const specifier of requested) {
      if (allow && !allow.includes(specifier)) {
        telemetry.recordAudit({ action: 'plugin:load', resource: specifier, status: 'BLOCKED', details: 'not in plugins.allow' });
        throw new PolicyError(`Plugin "${specifier}" is not in the organization allow-list (plugins.allow).`);
      }
      const isPath = specifier.startsWith('.') || path.isAbsolute(specifier);
      const resolved = isPath
        ? assertPathInside(projectDir, specifier, `Plugin path "${specifier}"`)
        : require.resolve(specifier, { paths: [projectDir] });
      // Idempotent across runs in one process (MCP server), by the file loaded: the same `./plugin.js` of two projects is two plugins.
      if (this.loadedSpecifiers.has(resolved)) continue;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(resolved);
      // `export default plugin`, `export const plugin = …`, or `module.exports = plugin` (CommonJS).
      const plugin: GherkinAIPlugin | undefined = mod?.default?.name ? mod.default : mod?.plugin ?? (typeof mod?.name === 'string' && typeof mod?.version === 'string' ? mod : undefined);
      if (plugin) {
        this.register(plugin);
      } else if (typeof mod?.register === 'function') {
        mod.register(this);
      } else {
        throw new ConfigError(`Plugin "${specifier}" does not export a GherkinAIPlugin or a register(registry) function.`);
      }
      telemetry.recordAudit({ action: 'plugin:load', resource: specifier, status: 'SUCCESS', details: resolved });
      this.loadedSpecifiers.add(resolved);
      loaded.push(specifier);
    }
    return loaded;
  }

  /** Reverse analyzers contributed by plugins (API 2), each tagged with the plugin it comes from. */
  public getReverseAnalyzers(): (SourceAnalyzer & { plugin: string })[] {
    return this.plugins.flatMap(p => (p.reverseAnalyzers?.() ?? []).map(a => Object.assign(a, { plugin: p.name })));
  }

  public getLintRules(): LintRule[] {
    return this.plugins.flatMap(p => p.lintRules?.() ?? []);
  }

  public getGatewayProviders(): (GatewayProvider & { plugin: string })[] {
    return this.plugins.flatMap(p => (p.gatewayProviders?.() ?? []).map(g => Object.assign(g, { plugin: p.name })));
  }

  public getMCPTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];
    for (const plugin of this.plugins) {
      if (plugin.mcpTools) {
        tools.push(...plugin.mcpTools());
      }
    }
    return tools;
  }
}

// Global singleton
export const pluginRegistry = new PluginRegistry();
