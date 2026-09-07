/* ==========================================================================
   gherkin-ai-cli - NestJS (cucumber-js) Preset Generator
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';

export function generateNodeNestJsPreset(parsed: ParsedFeature): { filename: string; content: string }[] {
  const className = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '');
  const moduleName = parsed.featureName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  const stepDefCode = `// cucumber-js Step Definitions for NestJS - ${parsed.featureName}
import { Given, When, Then, Before, After } from '@cucumber/cucumber';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
// import { AppModule } from '../../src/app.module';

let app: INestApplication;
let res: request.Response;

Before(async () => {
  /*
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();
  */
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

  return [
    {
      filename: `test/steps/${moduleName}.steps.ts`,
      content: stepDefCode
    }
  ];
}
