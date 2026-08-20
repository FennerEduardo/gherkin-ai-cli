import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { generateContracts } from '../src/generators/contracts';
import { detectExistingStack } from '../src/core/stack-detector';
import { defaultConfig } from '../src/core/config';
import { writeFileSync, removeFileSync, removeDirSync, ensureDirSync } from '../src/utils/file-system';
import { suggestPatterns } from '../src/core/patterns-suggester';
import { executeSandbox } from '../src/core/execution-sandbox';
import { parseExecutionFailure } from '../src/core/error-parser';
import { buildProjectContext } from '../src/core/context-builder';
import { validateGuardrails } from '../src/core/guardrails';
import { generateJavaSpringPreset } from '../src/generators/preset-java-spring';
import { generateReactPlaywrightPreset } from '../src/generators/preset-react-playwright';
import { calculateQualityScorecard } from '../src/core/quality-score';

const sampleSpec = `Feature: User Login Feature
  As an authenticated user
  I want to login with email and password

  Scenario: Login success
    Given a user with email "test@example.com" exists
    When user submits email "test@example.com" and password "Pass123!"
    Then response is 200 OK
    And emits "UserLoggedIn" event
`;

const sampleSpanishSpec = `Característica: Autenticación de Usuarios
  Como usuario registrado
  Quiero iniciar sesión

  Escenario: Login exitoso en español
    Dado que existe un usuario registrado con email "dev@example.com"
    Cuando envío credenciales válidas con email "dev@example.com"
    Entonces el sistema responde con HTTP 200 OK
    Y emite un evento "UsuarioAutenticado"
`;

describe('gherkin-ai CLI unit tests', () => {
  describe('AST Parser', () => {
    it('should parse English specification', () => {
      const parsed = parseGherkinText(sampleSpec);
      expect(parsed.featureName).toBe('User Login Feature');
      expect(parsed.scenarios.length).toBe(1);
      expect(parsed.scenarios[0].name).toBe('Login success');
      expect(parsed.scenarios[0].steps.length).toBe(4);
    });

    it('should parse Spanish (i18n) specification', () => {
      const parsedEs = parseGherkinText(sampleSpanishSpec);
      expect(parsedEs.featureName).toBe('Autenticación de Usuarios');
      expect(parsedEs.scenarios.length).toBe(1);
      expect(parsedEs.scenarios[0].steps[0].keyword).toBe('Given');
      expect(parsedEs.scenarios[0].steps[1].keyword).toBe('When');
      expect(parsedEs.scenarios[0].steps[2].keyword).toBe('Then');
      expect(parsedEs.scenarios[0].steps[3].keyword).toBe('And');
    });
  });

  describe('Contracts Generator', () => {
    it('should generate TypeScript contracts', () => {
      const parsed = parseGherkinText(sampleSpec);
      const { contractsTs, adrMd } = generateContracts(parsed, defaultConfig);
      expect(contractsTs).toContain('UserLoginFeatureCommandSchema');
      expect(adrMd).toContain('ADR 001');
    });

    it('should generate TypeScript contracts with semantic DTO validation', () => {
      const advancedSpec = `Feature: Registration
      Scenario: Register
        Given an email "test@test.com" @validate:email
        And an age "25" @range(18,100)`;
      const parsed = parseGherkinText(advancedSpec);
      const { contractsTs } = generateContracts(parsed, defaultConfig);
      expect(contractsTs).toContain('email: z.string().email()');
      expect(contractsTs).toContain('age: z.number().min(18).max(100)');
    });

    it('should generate Python (Pydantic) contracts', () => {
      const parsed = parseGherkinText(sampleSpec);
      const pythonConfig = { ...defaultConfig, stack: { ...defaultConfig.stack, language: 'python' } };
      const { nativeContract: pyContract } = generateContracts(parsed, pythonConfig);
      expect(pyContract?.filename).toBe('userloginfeature.contract.py');
      expect(pyContract?.content).toContain('class UserLoginFeatureCommand(BaseModel)');
    });

    it('should generate PHP 8.2 contracts', () => {
      const parsed = parseGherkinText(sampleSpec);
      const phpConfig = { ...defaultConfig, stack: { ...defaultConfig.stack, language: 'php' } };
      const { nativeContract: phpContract } = generateContracts(parsed, phpConfig);
      expect(phpContract?.filename).toBe('userloginfeature.contract.php');
      expect(phpContract?.content).toContain('readonly class UserLoginFeatureCommand');
    });
  });

  describe('Stack Auto-Detector', () => {
    it('should detect Node/TS stack', () => {
      const detected = detectExistingStack(process.cwd());
      expect(detected.projectMode).toBe('brownfield');
      expect(detected.stack.language).toBe('typescript');
    });

    it('should detect Laravel/PHP stack using mocks', () => {
      const mockLaravelDir = path.join(__dirname, 'mock-laravel');
      ensureDirSync(mockLaravelDir);
      writeFileSync(path.join(mockLaravelDir, 'artisan'), '#!/usr/bin/env php\n');
      writeFileSync(path.join(mockLaravelDir, 'composer.json'), JSON.stringify({ name: 'company/sim-rest' }));

      const detectedLaravel = detectExistingStack(mockLaravelDir);
      expect(detectedLaravel.stack.language).toBe('php');
      expect(detectedLaravel.stack.framework).toBe('laravel');
      expect(detectedLaravel.stack.orm).toBe('eloquent');
      removeDirSync(mockLaravelDir);
    });
  });

  describe('Closed-Loop Execution Sandbox', () => {
    it('should parse execution failure', () => {
      const sandboxResult = executeSandbox({ command: 'node -e "console.error(\\\"Error: AssertionError at src/app.ts:12\\\"); process.exit(1)"' });
      expect(sandboxResult.success).toBe(false);
      const diagnosis = parseExecutionFailure(sandboxResult);
      expect(diagnosis.affectedFiles).toContain('src/app.ts');
    });
  });

  describe('Context Builder & Guardrails', () => {
    it('should build project context', () => {
      const ctx = buildProjectContext();
      expect(ctx.detectedFiles.length).toBeGreaterThan(0);
    });

    it('should validate guardrails', () => {
      const guardRes = validateGuardrails(['src/index.ts']);
      expect(guardRes.allowed).toBe(true);
      const guardViolation = validateGuardrails(['infrastructure/db.tf']);
      expect(guardViolation.allowed).toBe(false);
    });
  });

  describe('Enterprise Presets', () => {
    it('should generate Java Spring preset', () => {
      const parsed = parseGherkinText(sampleSpec);
      const javaPreset = generateJavaSpringPreset(parsed);
      expect(javaPreset[0].content).toContain('Cucumber-JVM');
    });

    it('should generate React Playwright preset', () => {
      const parsed = parseGherkinText(sampleSpec);
      const reactPreset = generateReactPlaywrightPreset(parsed);
      expect(reactPreset[0].content).toContain('@playwright/test');
    });
  });

  describe('Quality Score Engine', () => {
    it('should calculate static score based on repository analysis', () => {
      const scorecard = calculateQualityScorecard();
      expect(typeof scorecard.overallScore).toBe('number');
      expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Patterns Suggester', () => {
    it('should suggest clean architecture patterns for React', () => {
      const mockReactStack = { framework: 'react', language: 'typescript' };
      const suggestions = suggestPatterns(mockReactStack, 'clean');
      expect(suggestions.designPatterns).toContain('Hooks Pattern');
      expect(suggestions.designPatterns).toContain('Repository Pattern');
      expect(suggestions.codingRules.some(rule => rule.includes('avoid "any"'))).toBe(true);
    });
  });
});
