/* ==========================================================================
   gherkin-ai-cli - NestJS (cucumber-js) Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { buildIR } from '../core/ir-builder';
import { generatePrismaSchema } from './prisma-generator';
import { generateNestJsCqrsModules } from './nestjs/cqrs-generator';
import { generateNestJsOutboxInfrastructure } from './nestjs/outbox-generator';
import { generateNestJsIdempotencyInterceptor } from './nestjs/idempotency-generator';
import { generateNestJsSagaInfrastructure } from './nestjs/saga-generator';
import { generateNestJsMultiTenancyInfrastructure } from './nestjs/multitenancy-generator';

export function generateNodeNestJsPreset(parsed: ParsedFeature, config?: GherkinAIConfig): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '');
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  const stepDefCode = `// cucumber-js Step Definitions for NestJS - ${parsed.featureName}
import { Given, When, Then, Before, After } from '@cucumber/cucumber';
import * as request from 'supertest';

let app: any;
let res: any;

Before(async () => {
  // Setup test HTTP application harness
});

After(async () => {
  // await app.close();
});

${parsed.scenarios.map(sc => `
// Scenario: ${sc.name}
${sc.steps.map(st => {
  let stepBody = '';
  
  // Basic heuristics for step implementation
  if (st.keyword.trim() === 'Given') {
    stepBody = "  // Set up preconditions\\n  // this.context = { ... };";
  } else if (st.keyword.trim() === 'When') {
    const isPost = /post|create|send/i.test(st.text);
    const method = isPost ? 'post' : 'get';
    const endpointMatch = st.text.match(/(?:\/api\/[\w/-]+)/i);
    const endpoint = endpointMatch ? endpointMatch[0] : '/api/v1/' + moduleName;
    
    stepBody = "  this.res = await request(app.getHttpServer())\\n    ." + method + "('" + endpoint + "')\\n    .send(this.payload || {});";
  } else if (st.keyword.trim() === 'Then') {
    const httpCodeMatch = st.text.match(/HTTP (?:status )?(\d{3})/i);
    if (httpCodeMatch) {
      stepBody = "  expect(this.res.status).toBe(" + httpCodeMatch[1] + ");";
    } else {
      stepBody = "  // Verify post-conditions\\n  expect(this.res.body).toBeDefined();";
    }
  } else {
    stepBody = "  // Additional context or assertions";
  }

  // Convert DataTable to variable if present
  let dataTableArg = '';
  if (st.text.includes('|')) {
    dataTableArg = 'dataTable: any';
    stepBody = "  const data = dataTable.hashes();\\n" + stepBody;
  }

  return `
${st.keyword.trim()}('${st.text.replace(/\n\|.*/g, '').replace(/'/g, "\\'")}'${dataTableArg ? ', async function (dataTable)' : ', async function ()'} {
${stepBody}
});
`;
}).join('')}
`).join('')}
`;

  const results = [
    {
      filename: `test/steps/${moduleName}.steps.ts`,
      content: stepDefCode
    },
    {
      filename: `src/${moduleName}/${moduleName}.cqrs.ts`,
      content: generateNestJsCqrsModules()
    },
    {
      filename: `src/infrastructure/outbox.service.ts`,
      content: generateNestJsOutboxInfrastructure()
    },
    {
      filename: `src/infrastructure/idempotency.interceptor.ts`,
      content: generateNestJsIdempotencyInterceptor()
    },
    ...generateNestJsSagaInfrastructure(parsed.featureName),
    ...generateNestJsMultiTenancyInfrastructure()
  ];

  if (config) {
    const ir = buildIR(parsed, 'feature.feature');
    results.push({
      filename: 'prisma/schema.prisma',
      content: generatePrismaSchema(ir, config)
    });
  }

  return results;
}
