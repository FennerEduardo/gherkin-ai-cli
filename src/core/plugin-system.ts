import { SpecificationIR } from './semantic-ir';
import { GherkinAIConfig } from './config';
import { Constitution } from './constitution';

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
