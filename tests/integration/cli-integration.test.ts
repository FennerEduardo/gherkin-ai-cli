import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('ghk CLI Integration Tests', () => {
  const testDir = path.join(__dirname, 'temp-workspace');

  beforeAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
    // Initialize a dummy project
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: "test-app", version: "1.0.0" }));
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should initialize config in non-interactive mode', () => {
    // Run the compiled CLI
    const cliPath = path.resolve(__dirname, '../../dist/index.js');
    execSync(`node ${cliPath} init --yes`, { cwd: testDir });
    
    expect(fs.existsSync(path.join(testDir, 'gherkin-ai.config.json'))).toBe(true);
  });

  it('should generate boilerplate and contracts', () => {
    const cliPath = path.resolve(__dirname, '../../dist/index.js');
    
    // Create a simple feature file
    const specsDir = path.join(testDir, 'specs');
    fs.mkdirSync(specsDir);
    fs.writeFileSync(path.join(specsDir, 'test.feature'), `
Feature: Dummy Test
  Scenario: Simple
    Given a dummy user
    When it acts
    Then it succeeds with HTTP status 200
    `);

    try {
      execSync(`node ${cliPath} generate --yes --spec-dir specs`, { cwd: testDir });
    } catch (e: any) {
      console.error(e.stdout ? e.stdout.toString() : e.message);
      console.error(e.stderr ? e.stderr.toString() : '');
      throw e;
    }

    const outDir = path.join(testDir, 'generated-specs');
    expect(fs.existsSync(path.join(outDir, 'contracts.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'openapi.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'fixtures.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'prompts', 'qa-agent.md'))).toBe(true);
  });
});
