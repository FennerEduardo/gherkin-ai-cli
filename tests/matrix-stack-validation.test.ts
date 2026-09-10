import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleInitCommand, generateGovernanceConfig } from '../src/commands/init';
import { generateContracts } from '../src/generators/contracts';
import { parseGherkinText } from '../src/core/gherkin-parser';
import { buildIR } from '../src/core/ir-builder';
import { loadConfig, GherkinAIConfig } from '../src/core/config';
import { generateInfra, getStackDockerDetails } from '../src/generators/infra';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

describe('Multi-Stack & Dual-Testing Matrix Test Suite', () => {
  const workspaceDir = path.join(__dirname, 'temp-matrix-workspace');

  beforeEach(() => {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 1. Backend Language Isolation Matrix Tests
  // --------------------------------------------------------------------------
  const backendMatrix = [
    {
      lang: 'php',
      framework: 'native-php',
      orm: 'pdo',
      validation: 'native-php-filter',
      testing: 'phpunit',
      expectedProhibited: ['laravel/framework', 'symfony/symfony', 'illuminate/*']
    },
    {
      lang: 'python',
      framework: 'fastapi',
      orm: 'sqlalchemy',
      validation: 'pydantic',
      testing: 'pytest',
      expectedProhibited: ['eval()', 'exec()']
    },
    {
      lang: 'java',
      framework: 'spring-boot',
      orm: 'hibernate',
      validation: 'jakarta-validation',
      testing: 'junit',
      expectedProhibited: ['org.springframework.beans.factory.annotation.Autowired on fields (use constructor injection)']
    },
    {
      lang: 'csharp',
      framework: 'aspnet-core',
      orm: 'entity-framework-core',
      validation: 'fluent-validation',
      testing: 'xunit',
      expectedProhibited: ['System.Data.SqlClient unparameterized queries']
    },
    {
      lang: 'go',
      framework: 'gin',
      orm: 'go-orm',
      validation: 'go-validator',
      testing: 'testing',
      expectedProhibited: ['ignored_err_check (_ = err)']
    },
    {
      lang: 'ruby',
      framework: 'rails',
      orm: 'ruby-orm',
      validation: 'active-model',
      testing: 'rspec',
      expectedProhibited: ['where() raw string interpolation']
    },
    {
      lang: 'typescript',
      framework: 'nestjs',
      orm: 'prisma',
      validation: 'zod',
      testing: 'vitest',
      expectedProhibited: ['express (use NestJS abstractions)']
    }
  ];

  backendMatrix.forEach((item) => {
    it(`should initialize clean ${item.lang.toUpperCase()} backend stack without cross-language leakage`, async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir);

      await handleInitCommand({
        yes: true,
        projectName: `matrix-${item.lang}-service`,
        architecture: 'hexagonal',
        language: item.lang,
        framework: item.framework,
        orm: item.orm,
        validation: item.validation,
        testing: item.testing,
        outputDir: './generated-specs'
      });

      const configPath = path.join(workspaceDir, 'gherkin-ai.config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = loadConfig(configPath);
      expect(config.stack.language).toBe(item.lang);
      expect(config.stack.framework).toBe(item.framework);
      expect(config.stack.orm).toBe(item.orm);
      expect(config.stack.validation).toBe(item.validation);
      expect(config.stack.testing).toBe(item.testing);

      const govPath = path.join(workspaceDir, '.ghkgovernance.yaml');
      expect(fs.existsSync(govPath)).toBe(true);

      const govParsed = YAML.parse(fs.readFileSync(govPath, 'utf8'));
      if (item.expectedProhibited.length > 0 && govParsed.prohibitedImports) {
        const langProhibited = govParsed.prohibitedImports[item.lang] || [];
        item.expectedProhibited.forEach((p) => {
          expect(langProhibited).toContain(p);
        });
      }

      cwdSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Dual Frontend + Backend Stack Combinations
  // --------------------------------------------------------------------------
  const frontendMatrix = [
    {
      backendLang: 'php',
      feFramework: 'vanilla-js',
      feLanguage: 'javascript',
      feBundler: 'vite',
      feUnit: 'vitest',
      feE2E: 'cypress'
    },
    {
      backendLang: 'python',
      feFramework: 'react',
      feLanguage: 'typescript',
      feBundler: 'vite',
      feUnit: 'vitest',
      feE2E: 'playwright'
    },
    {
      backendLang: 'java',
      feFramework: 'vue',
      feLanguage: 'typescript',
      feBundler: 'webpack',
      feUnit: 'jest',
      feE2E: 'cypress'
    },
    {
      backendLang: 'csharp',
      feFramework: 'angular',
      feLanguage: 'typescript',
      feBundler: 'vite',
      feUnit: 'vitest',
      feE2E: 'playwright'
    }
  ];

  frontendMatrix.forEach((item) => {
    it(`should support dual-stack for ${item.backendLang.toUpperCase()} + ${item.feFramework} with complementary unit (${item.feUnit}) and E2E (${item.feE2E}) testing`, async () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir);

      await handleInitCommand({
        yes: true,
        projectName: `dual-${item.backendLang}-${item.feFramework}`,
        architecture: 'monolith',
        language: item.backendLang,
        frontendFramework: item.feFramework,
        frontendLanguage: item.feLanguage,
        frontendBundler: item.feBundler,
        frontendUnitTesting: item.feUnit,
        frontendE2eTesting: item.feE2E
      });

      const config = loadConfig(path.join(workspaceDir, 'gherkin-ai.config.json'));
      expect(config.frontendStack).toBeDefined();
      expect(config.frontendStack?.framework).toBe(item.feFramework);
      expect(config.frontendStack?.language).toBe(item.feLanguage);
      expect(config.frontendStack?.bundler).toBe(item.feBundler);
      expect(config.frontendStack?.unitTesting).toBe(item.feUnit);
      expect(config.frontendStack?.e2eTesting).toBe(item.feE2E);

      const govPath = path.join(workspaceDir, '.ghkgovernance.yaml');
      const govContent = fs.readFileSync(govPath, 'utf8');

      // Assert governance policy incorporates frontend paths and test configs
      expect(govContent).toContain('cypress/**');
      expect(govContent).toContain('e2e/**');
      expect(govContent).toContain('package.json');

      cwdSpy.mockRestore();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Contract & ADR Generation Assertions Across Stacks
  // --------------------------------------------------------------------------
  it('should generate ADR 001 detailing both backend and frontend unit+e2e testing frameworks', () => {
    const dummyFeature = `
Feature: Customer Management
  Scenario: Register Customer
    Given a new customer payload
    When registering customer
    Then HTTP status should be 201
`;
    const parsed = parseGherkinText(dummyFeature);
    const ir = buildIR(parsed, 'customermanagement.feature');

    const config: GherkinAIConfig = {
      projectName: 'enterprise-php-monolith',
      architecture: 'monolith',
      stack: {
        language: 'php',
        framework: 'native-php',
        orm: 'pdo',
        database: 'mysql',
        validation: 'native-php-filter',
        auth: 'jwt-bcrypt',
        testing: 'phpunit'
      },
      frontendStack: {
        framework: 'vanilla-js',
        language: 'javascript',
        bundler: 'vite',
        unitTesting: 'vitest',
        e2eTesting: 'cypress'
      },
      rules: {},
      outputDir: './generated-specs'
    };

    const output = generateContracts(parsed, ir, config);
    expect(output.adrMd).toContain('**Primary Backend Language**: php');
    expect(output.adrMd).toContain('**Backend Testing Framework**: phpunit');
    expect(output.adrMd).toContain('**Frontend Framework**: vanilla-js');
    expect(output.adrMd).toContain('**Frontend Unit Testing**: vitest');
    expect(output.adrMd).toContain('**Frontend E2E Testing**: cypress');

    expect(output.nativeContract).toBeDefined();
    expect(output.nativeContract?.filename).toBe('customermanagement.contract.php');
    expect(output.nativeContract?.content).toContain('namespace App\\Domain\\Contracts');
  });

  // --------------------------------------------------------------------------
  // 4. Docker Container Sandbox & Infrastructure Generator Validation Matrix
  // --------------------------------------------------------------------------
  const dockerMatrix = [
    {
      lang: 'php',
      testing: 'phpunit',
      database: 'mysql',
      expectedImage: 'php:8.3-cli-alpine',
      expectedTestCmd: 'vendor/bin/phpunit',
      expectedDbImage: 'mysql:8.0'
    },
    {
      lang: 'csharp',
      testing: 'xunit',
      database: 'postgresql',
      expectedImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
      expectedTestCmd: 'dotnet test',
      expectedDbImage: 'postgres:16-alpine'
    },
    {
      lang: 'java',
      testing: 'junit',
      database: 'postgresql',
      expectedImage: 'eclipse-temurin:21-jdk-alpine',
      expectedTestCmd: './gradlew test',
      expectedDbImage: 'postgres:16-alpine'
    },
    {
      lang: 'python',
      testing: 'pytest',
      database: 'postgresql',
      expectedImage: 'python:3.11-slim',
      expectedTestCmd: 'pytest',
      expectedDbImage: 'postgres:16-alpine'
    },
    {
      lang: 'go',
      testing: 'testing',
      database: 'mongodb',
      expectedImage: 'golang:1.22-alpine',
      expectedTestCmd: 'go test ./...',
      expectedDbImage: 'mongo:7.0'
    },
    {
      lang: 'ruby',
      testing: 'rspec',
      database: 'postgresql',
      expectedImage: 'ruby:3.3-alpine',
      expectedTestCmd: 'bundle exec rspec',
      expectedDbImage: 'postgres:16-alpine'
    },
    {
      lang: 'typescript',
      testing: 'vitest',
      database: 'postgresql',
      expectedImage: 'node:20-alpine',
      expectedTestCmd: 'npx vitest run',
      expectedDbImage: 'postgres:16-alpine'
    }
  ];

  dockerMatrix.forEach((item) => {
    it(`should generate valid Docker compose configuration & sandbox details for ${item.lang.toUpperCase()} stack`, () => {
      const config: GherkinAIConfig = {
        projectName: `test-${item.lang}-app`,
        architecture: 'monolith',
        stack: {
          language: item.lang,
          framework: 'default',
          orm: 'default',
          database: item.database,
          validation: 'default',
          testing: item.testing
        },
        rules: {},
        outputDir: './generated-specs'
      };

      // 1. Verify getStackDockerDetails helper
      const dockerDetails = getStackDockerDetails(config);
      expect(dockerDetails.image).toBe(item.expectedImage);
      expect(dockerDetails.testCmd).toBe(item.expectedTestCmd);

      // 2. Verify generateInfra docker-compose.yml output
      const infra = generateInfra(config);
      expect(infra.dockerComposeYaml).toContain(`image: ${item.expectedImage}`);
      expect(infra.dockerComposeYaml).toContain(`container_name: test-${item.lang}-app-app`);
      expect(infra.dockerComposeYaml).toContain('volumes:\n      - .:/app');
      expect(infra.dockerComposeYaml).toContain('working_dir: /app');
      expect(infra.dockerComposeYaml).toContain(`image: ${item.expectedDbImage}`);
    });
  });
});
