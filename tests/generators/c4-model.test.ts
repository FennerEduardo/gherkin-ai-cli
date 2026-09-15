import { describe, it, expect } from 'vitest';
import { generateC4ModelMermaid } from '../../src/generators/c4-model';
import { SpecificationIR } from '../../src/core/semantic-ir';
import { GherkinAIConfig } from '../../src/core/config';

describe('generateC4ModelMermaid', () => {
  it('should generate a valid Mermaid C4 diagram', () => {
    const ir: SpecificationIR = {
      featureName: 'TestFeature',
      sourceFile: 'test.feature',
      scenarios: [
        { name: 'S1', category: 'happy-path', steps: [] }
      ],
      events: [],
      commands: [],
      fields: [],
      risks: [],
      assumptions: [],
      policies: [],
      apiEndpoints: [
        { method: 'POST', path: '/api/test', operationId: 'CreateTest', authRequired: false, requestFields: [], httpCodes: [] }
      ],
      traceability: { links: [], coverage: { specifiedRequirements: 0, testedRequirements: 0, coveragePercent: 0 } },
      qualityIndicators: { scenarioCompleteness: 100, missingScenarioCategories: [], contradictions: [], ambiguities: [] },
      constraints: []
    };

    const config: GherkinAIConfig = {
      projectName: 'PaymentPlatform',
      architecture: 'microservices',
      stack: { language: 'csharp', framework: 'aspnet-core', orm: 'entity-framework-core', database: 'postgresql', validation: 'fluent-validation', auth: 'jwt-bcrypt', testing: 'xunit', messaging: 'rabbitmq' },
      rules: { strictLayerBoundaries: true },
      outputDir: './generated'
    };

    const mermaid = generateC4ModelMermaid(ir, config);
    expect(mermaid).toContain('C4Context');
    expect(mermaid).toContain('C4Container');
    expect(mermaid).toContain('C4Component');
    expect(mermaid).toContain('System(system, "PaymentPlatform"');
    expect(mermaid).toContain('ContainerDb(db, "Database", "postgresql"');
    expect(mermaid).toContain('Container(bus, "Message Bus", "rabbitmq"');
    expect(mermaid).toContain('Component(comp0, "CreateTest Controller"');
  });
});
