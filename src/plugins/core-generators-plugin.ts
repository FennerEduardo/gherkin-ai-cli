import { GherkinAIPlugin, GeneratedArtifact, PluginContext } from '../core/plugin-system';
import { SpecificationIR } from '../core/semantic-ir';
import { GherkinAIConfig } from '../core/config';
import { generateContracts } from '../generators/contracts';
import { generateFixtures } from '../generators/fixtures';
import { generatePrompts } from '../generators/prompts';
import { generateInfra } from '../generators/infra';
import { generateAwsCdkInfrastructure } from '../generators/infrastructure/aws-cdk-generator';
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
    scenarios: (ir.scenarios || []).map((sc: any) => ({
      name: sc.name,
      tags: sc.tags || [],
      steps: [
        ...(sc.preconditions || []).map((p: string) => ({ keyword: 'Given', text: p, tags: [] })),
        ...(sc.actions || []).map((a: string) => ({ keyword: 'When', text: a, tags: [] })),
        ...(sc.expectations || []).map((e: string) => ({ keyword: 'Then', text: e, tags: [] }))
      ]
    })),
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
    const result = generateContracts(parsed, ir, config);
    
    const artifacts: GeneratedArtifact[] = [
      { filePath: 'ADR-001-architecture-decisions.md', content: result.adrMd, type: 'other' },
      { filePath: 'openapi.json', content: result.openApiJson, type: 'openapi' }
    ];

    if (config.stack.language === 'node' || config.stack.language === 'typescript' || config.stack.language === 'javascript' || config.stack.language === 'nest' || config.stack.language === 'nestjs') {
      artifacts.push({ filePath: 'contracts.ts', content: result.contractsTs, type: 'contract' });
    }

    if (result.asyncApiJson) {
      artifacts.push({ filePath: 'asyncapi.json', content: result.asyncApiJson, type: 'contract' });
    }

    if (result.nativeContract) {
      artifacts.push({ filePath: result.nativeContract.filename, content: result.nativeContract.content, type: 'contract' });
    }
    
    if (result.projectRootFile) {
      if (Array.isArray(result.projectRootFile)) {
        result.projectRootFile.forEach(f => artifacts.push({ filePath: f.filename, content: f.content, type: 'config' }));
      } else {
        artifacts.push({ filePath: result.projectRootFile.filename, content: result.projectRootFile.content, type: 'config' });
      }
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

    // Ensure AWS CDK is connected to the central pipeline
    // This addresses the gap reported in the Java+Spring+AWS scenario
    const cdkStack = generateAwsCdkInfrastructure(config.projectName);
    artifacts.push({ filePath: `infrastructure/lib/${config.projectName}-stack.ts`, content: cdkStack, type: 'config' });
    
    artifacts.push({
      filePath: `infrastructure/cdk.json`,
      content: JSON.stringify({ app: `npx ts-node bin/${config.projectName}.ts` }, null, 2),
      type: 'config'
    });
    
    artifacts.push({
      filePath: `infrastructure/package.json`,
      content: JSON.stringify({
        name: `${config.projectName}-infra`,
        version: "0.1.0",
        dependencies: {
          "aws-cdk-lib": "2.100.0",
          "constructs": "10.0.0"
        },
        devDependencies: {
          "aws-cdk": "2.100.0",
          "ts-node": "^10.9.1",
          "typescript": "~5.2.2"
        },
        scripts: {
          "synth": "cdk synth"
        }
      }, null, 2),
      type: 'config'
    });

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
