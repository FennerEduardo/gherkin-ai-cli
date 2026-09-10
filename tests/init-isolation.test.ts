import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleInitCommand, generateGovernanceConfig } from '../src/commands/init';
import { loadConfig } from '../src/core/config';
import fs from 'fs';
import path from 'path';

describe('ghk init language isolation & frontend test complementary configuration', () => {
  const tempDir = path.join(__dirname, 'temp-init-isolation-workspace');

  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should initialize PHP stack without JS testing or validation leakage, supporting frontend vitest + cypress', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    await handleInitCommand({
      yes: true,
      projectName: 'enterprise-php-monolith',
      architecture: 'monolith',
      language: 'php',
      framework: 'native-php',
      orm: 'pdo',
      database: 'mysql',
      validation: 'native-php-filter',
      testing: 'phpunit',
      frontendFramework: 'vanilla-js',
      frontendLanguage: 'javascript',
      frontendBundler: 'vite',
      frontendUnitTesting: 'vitest',
      frontendE2eTesting: 'cypress',
      outputDir: './generated-specs'
    });

    const configPath = path.join(tempDir, 'gherkin-ai.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = loadConfig(configPath);
    expect(config.stack.language).toBe('php');
    expect(config.stack.framework).toBe('native-php');
    expect(config.stack.orm).toBe('pdo');
    expect(config.stack.validation).toBe('native-php-filter');
    expect(config.stack.testing).toBe('phpunit');

    expect(config.frontendStack).toBeDefined();
    expect(config.frontendStack?.framework).toBe('vanilla-js');
    expect(config.frontendStack?.language).toBe('javascript');
    expect(config.frontendStack?.bundler).toBe('vite');
    expect(config.frontendStack?.unitTesting).toBe('vitest');
    expect(config.frontendStack?.e2eTesting).toBe('cypress');

    const govPath = path.join(tempDir, '.ghkgovernance.yaml');
    expect(fs.existsSync(govPath)).toBe(true);
    const govContent = fs.readFileSync(govPath, 'utf8');
    expect(govContent).toContain('cypress');
    expect(govContent).toContain('vitest.config.ts');
    expect(govContent).toContain('cypress.config.ts');

    cwdSpy.mockRestore();
  });
});
