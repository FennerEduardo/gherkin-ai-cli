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
${sc.steps.map(st => `
${st.keyword.trim()}('${st.text.replace(/'/g, "\\'")}', async function () {
  // TODO: Implement step
  return 'pending';
});
`).join('')}
`).join('')}
`;

  return [
    {
      filename: `test/steps/${moduleName}.steps.ts`,
      content: stepDefCode
    }
  ];
}
