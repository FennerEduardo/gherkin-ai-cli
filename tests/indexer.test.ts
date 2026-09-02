import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StepIndexer } from '../src/core/step-indexer';
import { ContextExtractor } from '../src/core/context-extractor';
import fs from 'fs';
import path from 'path';

describe('Context Extraction and Step Indexing', () => {
  const testWorkspace = path.join(__dirname, '.test_workspace');

  beforeAll(() => {
    // Setup a mock workspace
    fs.mkdirSync(testWorkspace, { recursive: true });
    
    // Prisma schema
    fs.mkdirSync(path.join(testWorkspace, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(testWorkspace, 'prisma', 'schema.prisma'), `
      model User {
        id String @id
        email String @unique
      }
    `);

    // Step definitions
    fs.mkdirSync(path.join(testWorkspace, 'e2e', 'steps'), { recursive: true });
    fs.writeFileSync(path.join(testWorkspace, 'e2e', 'steps', 'login.steps.ts'), `
      import { Given, When } from 'some-cucumber-lib';
      Given('I navigate to the login page', () => {});
      When(/^I type my credentials$/, () => {});
    `);

    // POM Selectors
    fs.writeFileSync(path.join(testWorkspace, 'e2e', 'login.page.ts'), `
      const submitBtn = '[data-testid="submit-login"]';
      const emailInput = "[data-test='email-input']";
    `);
  });

  afterAll(() => {
    // Cleanup
    fs.rmSync(testWorkspace, { recursive: true, force: true });
  });

  it('should extract Prisma data models', () => {
    const extractor = new ContextExtractor();
    const ctx = extractor.extract(testWorkspace);
    
    expect(ctx.dataModels.length).toBe(1);
    expect(ctx.dataModels[0]).toContain('model User');
  });

  it('should extract DOM selectors', () => {
    const extractor = new ContextExtractor();
    const ctx = extractor.extract(testWorkspace);
    
    expect(ctx.domSelectors).toContain('submit-login');
    expect(ctx.domSelectors).toContain('email-input');
  });

  it('should index TypeScript step definitions', () => {
    const indexer = new StepIndexer();
    const steps = indexer.getAvailableSteps(testWorkspace);
    
    expect(steps.length).toBe(2);
    expect(steps.find(s => s.keyword === 'Given')?.pattern).toBe('I navigate to the login page');
    expect(steps.find(s => s.keyword === 'When')?.pattern).toBe('/^I type my credentials$/');
  });
});
