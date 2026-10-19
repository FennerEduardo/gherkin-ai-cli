import fs from 'fs';
import path from 'path';
import { GherkinAIPlugin, GeneratedArtifact, PluginContext } from '../core/plugin-system';
import { SpecificationIR } from '../core/semantic-ir';
import { GherkinAIConfig } from '../core/config';
import { generateContracts } from '../generators/contracts';
import { generateFixtures } from '../generators/fixtures';
import { generatePrompts } from '../generators/prompts';
import { generateInfra } from '../generators/infra';
import { generateAwsCdkApp } from '../generators/infrastructure/aws-cdk-generator';
import { renderDeploymentTargets } from '../generators/deploy/targets';
import { renderCiPipelines } from '../generators/cicd';

export function awsCdkEnabled(config: GherkinAIConfig): boolean {
  return config.infrastructure?.awsCdk ?? ['sqs', 'sns'].includes((config.stack.messaging || '').toLowerCase());
}
import { generatePresets } from '../generators/presets';
import { generatePrismaStack } from '../generators/prisma-stack';
import { ParsedFeature } from '../core/gherkin-parser';
import { getSourceFeature } from '../core/ir-builder';
import { CONTRACTS_DIR, collectFeatureContracts, featureContractSlug, mergeAsyncApi, mergeOpenApi } from '../core/contracts/merge';
import { featurePascalName } from '../utils/naming';
import { parseGherkinText } from '../core/gherkin-parser';
import { projectFeatureFiles } from '../core/workspace-projects';

// Helper to convert IR back to ParsedFeature for legacy generators
// In a real refactor, the generators would be updated to accept IR natively.
function irToParsedFeature(ir: SpecificationIR | any): ParsedFeature {
  const source = getSourceFeature(ir);
  if (source) return source;
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

const toPosix = (p: string) => p.split(path.sep).join('/').replace(/^\.\//, '');

/**
 * The project's other features (spec directory), for service-wide files that must describe every feature
 * (Prisma schema). Unreadable or unparseable features are skipped; `ghk lint` reports them.
 */
export function otherProjectFeatures(ir: SpecificationIR, current: ParsedFeature, cwd = process.cwd()): ParsedFeature[] {
  let files: string[] = [];
  try { files = projectFeatureFiles(cwd); } catch { return []; }
  const self = ir.sourceFile ? path.resolve(cwd, ir.sourceFile) : '';
  const others: ParsedFeature[] = [];
  for (const file of files) {
    if (path.resolve(file) === self) continue;
    try {
      const parsed = parseGherkinText(fs.readFileSync(file, 'utf8'));
      if (featurePascalName(parsed) !== featurePascalName(current)) others.push(parsed);
    } catch { /* skipped */ }
  }
  return others;
}

/**
 * Where the generated project finds its feature file, relative to the output directory.
 * Generated test runners (Maven test resources, Reqnroll, godog, cucumber-js, Behat, ...) expect
 * features/ inside the project, so a feature that lives outside outputDir is copied verbatim into
 * <outputDir>/features/ and bound from there.
 */
export function resolveFeatureForOutput(ir: SpecificationIR, config: GherkinAIConfig, cwd = process.cwd()): { featureFile?: string; copy?: GeneratedArtifact } {
  const source = ir.sourceFile;
  if (!source || !source.endsWith('.feature')) return {};
  const sourceAbs = path.resolve(cwd, source);
  const outAbs = path.resolve(cwd, config.outputDir || './');
  const rel = path.relative(outAbs, sourceAbs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { featureFile: toPosix(rel) };
  if (!fs.existsSync(sourceAbs)) return {};
  const featureFile = `features/${path.basename(sourceAbs)}`;
  return { featureFile, copy: { filePath: featureFile, content: fs.readFileSync(sourceAbs, 'utf8'), type: 'other' } };
}

export class CoreContractsPlugin implements GherkinAIPlugin {
  name = 'ghk-core-contracts';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    const parsed = irToParsedFeature(ir);
    const result = generateContracts(parsed, ir, config);

    // Each feature owns contracts/<feature>/; the root openapi.json / asyncapi.json are the union of all
    // features, so generating one feature no longer drops the routes and channels of the others.
    const slug = featureContractSlug(ir.sourceFile, parsed.featureName);
    const outDir = path.resolve(process.cwd(), config.outputDir || './');
    const featureDir = `${CONTRACTS_DIR}/${slug}`;
    const openApi = JSON.parse(result.openApiJson);
    const mergedOpenApi = mergeOpenApi(collectFeatureContracts(outDir, 'openapi.json', slug, openApi), config.projectName);

    const artifacts: GeneratedArtifact[] = [
      { filePath: 'ADR-001-architecture-decisions.md', content: result.adrMd, type: 'other' },
      { filePath: `${featureDir}/ADR-${featurePascalName(parsed) || 'Feature'}.md`, content: result.adrMd, type: 'other' },
      { filePath: `${featureDir}/openapi.json`, content: result.openApiJson, type: 'openapi' },
      { filePath: 'openapi.json', content: JSON.stringify(mergedOpenApi, null, 2), type: 'openapi' }
    ];

    if (config.stack.language === 'node' || config.stack.language === 'typescript' || config.stack.language === 'javascript' || config.stack.language === 'nest' || config.stack.language === 'nestjs') {
      artifacts.push({ filePath: 'contracts.ts', content: result.contractsTs, type: 'contract' });
    }

    if (result.asyncApiJson) {
      const mergedAsyncApi = mergeAsyncApi(collectFeatureContracts(outDir, 'asyncapi.json', slug, JSON.parse(result.asyncApiJson)), config.projectName);
      artifacts.push({ filePath: `${featureDir}/asyncapi.json`, content: result.asyncApiJson, type: 'contract' });
      artifacts.push({ filePath: 'asyncapi.json', content: JSON.stringify(mergedAsyncApi, null, 2), type: 'contract' });
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
    const { featureFile, copy } = resolveFeatureForOutput(ir, config);
    const presets = generatePresets(parsed, config, featureFile);
    const artifacts: GeneratedArtifact[] = presets.map(p => ({
      filePath: p.filename,
      content: p.content,
      type: 'test'
    }));
    return copy ? [copy, ...artifacts] : artifacts;
  }
}

export class CorePrismaPlugin implements GherkinAIPlugin {
  name = 'ghk-core-prisma';
  version = '1.0.0';

  generate(ir: SpecificationIR, config: GherkinAIConfig): GeneratedArtifact[] {
    if (config.stack.orm !== 'prisma') return [];
    
    const parsed = irToParsedFeature(ir);
    const prismaArtifacts = generatePrismaStack(parsed, config, otherProjectFeatures(ir, parsed));
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

    // AWS CDK app: opt-in (infrastructure.awsCdk), on by default when messaging targets SQS/SNS.
    if (awsCdkEnabled(config)) {
      for (const file of generateAwsCdkApp(config.projectName)) artifacts.push({ filePath: file.filename, content: file.content, type: 'config' });
    }

    // Deployment targets (config.deploy): Terraform for the chosen cloud and/or a Helm chart.
    for (const file of renderDeploymentTargets(config)) artifacts.push({ filePath: file.filename, content: file.content, type: 'config' });

    // CI/CD pipeline (config.ci, or GitHub Actions with deploy): at the repository root, whatever outputDir is.
    const toRoot = path.relative(path.resolve(config.outputDir || '.'), process.cwd()).split(path.sep).join('/');
    for (const file of renderCiPipelines(config)) {
      artifacts.push({ filePath: toRoot ? `${toRoot}/${file.filename}` : file.filename, content: file.content, type: 'config' });
    }

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
