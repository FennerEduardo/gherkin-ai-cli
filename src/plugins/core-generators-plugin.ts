import { GherkinAIPlugin, GeneratedArtifact, PluginContext } from '../core/plugin-system';
import { SpecificationIR } from '../core/semantic-ir';
import { GherkinAIConfig } from '../core/config';
import { generateContracts } from '../generators/contracts';
import { generateFixtures } from '../generators/fixtures';
import { generatePrompts } from '../generators/prompts';
import { generateInfra } from '../generators/infra';
import { generatePresets } from '../generators/presets';
import { generatePrismaStack } from '../generators/prisma-stack';
import { ParsedFeature } from '../core/gherkin-parser';

// Helper to convert IR back to ParsedFeature for legacy generators
// In a real refactor, the generators would be updated to accept IR natively.
function irToParsedFeature(ir: SpecificationIR | any): ParsedFeature {
  return {
    featureName: ir.featureName || 'AppFeature',
    descriptionLines: ir.featureDescription || [],
    tags: ir.tags || [],
    scenarios: [],
    domainAnalysis: {
      actors: (ir.actors || []).map((a: any) => a.name),
      commands: (ir.commands || []).map((c: any) => c.name),
      queries: (ir.queries || []).map((q: any) => q.name),
      events: (ir.events || []).map((e: any) => e.name),
      fields: (ir.fields || []).map((f: any) => ({
        ...f,
        validations: (f.validations || []).map((v: any) => {
          if (typeof v === 'string') return v;
          if (v.type === 'email') return '@validate:email';
          if (v.type === 'range') return `@range(${v.params?.min || 0},${v.params?.max || 100})`;
          return `@${v.type}`;
        })
      })),
      httpCodes: (ir.apiEndpoints || []).flatMap((e: any) => e.httpCodes.map((c: any) => c.code)),
      fixtures: []
    }
  };
}

export class CoreContractsPlugin implements GherkinAIPlugin {
  name = 'ghk-core-contracts';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const parsed = irToParsedFeature(ir);
    const result = generateContracts(parsed, config);
    
    const artifacts: GeneratedArtifact[] = [
      { filePath: 'contracts.ts', content: result.contractsTs, type: 'contract' },
      { filePath: 'ADR-001-architecture-decisions.md', content: result.adrMd, type: 'other' },
      { filePath: 'openapi.json', content: result.openApiJson, type: 'openapi' }
    ];

    if (result.nativeContract) {
      artifacts.push({ filePath: result.nativeContract.filename, content: result.nativeContract.content, type: 'contract' });
    }

    return artifacts;
  }
}

export class CoreFixturesPlugin implements GherkinAIPlugin {
  name = 'ghk-core-fixtures';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const parsed = irToParsedFeature(ir);
    const result = generateFixtures(parsed, config);
    return [
      { filePath: 'fixtures.ts', content: result.fixturesTs, type: 'fixture' },
      { filePath: 'seed.sql', content: result.seedSql, type: 'fixture' }
    ];
  }
}

export class CorePresetsPlugin implements GherkinAIPlugin {
  name = 'ghk-core-presets';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const parsed = irToParsedFeature(ir);
    const presets = generatePresets(parsed, config);
    return presets.map((p: any) => ({
      filePath: p.filename,
      content: p.content,
      type: 'test'
    }));
  }
}

export class CorePrismaPlugin implements GherkinAIPlugin {
  name = 'ghk-core-prisma';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    if (config.stack.orm !== 'prisma') return [];
    
    const parsed = irToParsedFeature(ir);
    const prismaArtifacts = generatePrismaStack(parsed, config);
    return prismaArtifacts.map((p: any) => ({
      filePath: p.filename,
      content: p.content,
      type: 'other'
    }));
  }
}

export class CoreInfraPlugin implements GherkinAIPlugin {
  name = 'ghk-core-infra';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const result = generateInfra(config);
    const artifacts: GeneratedArtifact[] = [];

    if (config.architecture === 'serverless') {
      artifacts.push({ filePath: 'serverless.yml', content: result.serverlessYml, type: 'config' });
    } else {
      artifacts.push({ filePath: 'docker-compose.yml', content: result.dockerComposeYaml, type: 'config' });
    }
    artifacts.push({ filePath: '.env.example', content: result.envExample, type: 'config' });

    return artifacts;
  }
}

// Prompts plugin requires dynamic agent selection, so we pass it via config or it just generates all available.
export class CorePromptsPlugin implements GherkinAIPlugin {
  name = 'ghk-core-prompts';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const parsed = irToParsedFeature(ir);
    const prompts = generatePrompts(parsed, config);
    const artifacts: GeneratedArtifact[] = [];

    for (const [filename, content] of Object.entries(prompts)) {
      artifacts.push({
        filePath: `prompts/${filename}`,
        content: content as string,
        type: 'prompt'
      });
    }

    return artifacts;
  }
}

export function registerCorePlugins(registry: any) {
  registry.register(new CoreContractsPlugin());
  registry.register(new CoreFixturesPlugin());
  registry.register(new CorePresetsPlugin());
  registry.register(new CorePrismaPlugin());
  registry.register(new CoreInfraPlugin());
  registry.register(new CorePromptsPlugin());
}
