import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import inquirer from 'inquirer';
import { defaultConfig, saveConfig, GherkinAIConfig } from '../core/config';
import { generateConstitution } from '../core/constitution';
import { logger } from '../utils/logger';
import { promptOrFallback } from '../utils/i18n-cli';
import { ensureGitignore } from '../utils/gitignore-manager';

const FRAMEWORKS_BY_LANG: Record<string, { name: string; value: string }[]> = {
  php: [
    { name: 'PHP 8.3 Native (No framework, pure PDO/MVC)', value: 'native-php' },
    { name: 'Laravel Framework', value: 'laravel' },
    { name: 'Symfony Framework', value: 'symfony' }
  ],
  typescript: [
    { name: 'NestJS (Modular DDD)', value: 'nestjs' },
    { name: 'Express.js', value: 'express' },
    { name: 'Fastify', value: 'fastify' }
  ],
  javascript: [
    { name: 'Express.js', value: 'express' },
    { name: 'Fastify', value: 'fastify' },
    { name: 'Node.js Native HTTP', value: 'node-native' }
  ],
  python: [
    { name: 'FastAPI (Async REST)', value: 'fastapi' },
    { name: 'Django Framework', value: 'django' },
    { name: 'Flask', value: 'flask' }
  ],
  java: [
    { name: 'Spring Boot', value: 'spring-boot' },
    { name: 'Quarkus', value: 'quarkus' }
  ],
  csharp: [
    { name: 'ASP.NET Core', value: 'dotnet-aspnetcore' }
  ],
  go: [
    { name: 'Gin Web Framework', value: 'gin' },
    { name: 'Fiber', value: 'fiber' },
    { name: 'Echo', value: 'echo' }
  ],
  ruby: [
    { name: 'Ruby on Rails', value: 'rails' },
    { name: 'Sinatra', value: 'sinatra' }
  ]
};

const ORMS_BY_LANG: Record<string, { name: string; value: string }[]> = {
  php: [
    { name: 'PDO Native (Prepared Statements)', value: 'pdo' },
    { name: 'Eloquent ORM', value: 'eloquent' },
    { name: 'Doctrine ORM', value: 'doctrine' }
  ],
  typescript: [
    { name: 'Prisma ORM', value: 'prisma' },
    { name: 'Drizzle ORM', value: 'drizzle' },
    { name: 'TypeORM', value: 'typeorm' }
  ],
  python: [
    { name: 'SQLAlchemy', value: 'sqlalchemy' },
    { name: 'Django ORM', value: 'django-orm' }
  ],
  java: [
    { name: 'Hibernate / JPA', value: 'hibernate' }
  ],
  csharp: [
    { name: 'Entity Framework Core', value: 'entity-framework-core' },
    { name: 'Dapper', value: 'dapper' }
  ]
};

const VALIDATIONS_BY_LANG: Record<string, { name: string; value: string }[]> = {
  php: [
    { name: 'Native PHP Filters (filter_var / filter_input)', value: 'native-php-filter' },
    { name: 'Valitron (Simple PHP Validation)', value: 'valitron' },
    { name: 'Respect\\Validation (Fluent PHP Validation)', value: 'respect-validation' },
    { name: 'Symfony Validator', value: 'symfony-validator' },
    { name: 'Custom Rules', value: 'custom' }
  ],
  typescript: [
    { name: 'Zod (TypeScript-first schema validation)', value: 'zod' },
    { name: 'Joi (Schema Description & Validator)', value: 'joi' },
    { name: 'Yup', value: 'yup' },
    { name: 'class-validator (Decorator-based validation)', value: 'class-validator' },
    { name: 'Custom', value: 'custom' }
  ],
  javascript: [
    { name: 'Zod (Schema validation)', value: 'zod' },
    { name: 'Joi (Schema Description & Validator)', value: 'joi' },
    { name: 'Yup', value: 'yup' },
    { name: 'Custom', value: 'custom' }
  ],
  python: [
    { name: 'Pydantic (Data validation using Python type hints)', value: 'pydantic' },
    { name: 'Marshmallow', value: 'marshmallow' },
    { name: 'Cerberus', value: 'cerberus' },
    { name: 'Custom', value: 'custom' }
  ],
  java: [
    { name: 'Jakarta Validation / Hibernate Validator', value: 'jakarta-validation' },
    { name: 'Custom', value: 'custom' }
  ],
  csharp: [
    { name: 'FluentValidation (.NET Validation Library)', value: 'fluent-validation' },
    { name: 'System.ComponentModel.DataAnnotations', value: 'data-annotations' },
    { name: 'Custom', value: 'custom' }
  ],
  go: [
    { name: 'go-playground/validator', value: 'go-validator' },
    { name: 'ozzo-validation', value: 'ozzo-validation' },
    { name: 'Custom', value: 'custom' }
  ],
  ruby: [
    { name: 'ActiveModel::Validations', value: 'active-model' },
    { name: 'Dry-Validation', value: 'dry-validation' },
    { name: 'Custom', value: 'custom' }
  ]
};

const TESTING_BY_LANG: Record<string, { name: string; value: string }[]> = {
  php: [
    { name: 'PHPUnit (Standard PHP Unit Testing)', value: 'phpunit' },
    { name: 'Pest PHP (Elegant Testing Framework for PHP)', value: 'pest' }
  ],
  python: [
    { name: 'PyTest (Modern Async & Fixture Testing)', value: 'pytest' },
    { name: 'unittest (Standard Python Testing Library)', value: 'unittest' }
  ],
  java: [
    { name: 'JUnit 5 (Modern Java Unit Testing)', value: 'junit' },
    { name: 'TestNG', value: 'testng' }
  ],
  csharp: [
    { name: 'xUnit.net (Modern .NET Unit Testing)', value: 'xunit' },
    { name: 'NUnit', value: 'nunit' }
  ],
  go: [
    { name: 'testing (Go Native Unit Testing)', value: 'testing' },
    { name: 'Ginkgo (BDD Testing Framework for Go)', value: 'ginkgo' }
  ],
  ruby: [
    { name: 'RSpec (BDD Testing for Ruby)', value: 'rspec' },
    { name: 'Minitest', value: 'minitest' }
  ],
  typescript: [
    { name: 'Vitest (Fast ESM Native Testing Framework)', value: 'vitest' },
    { name: 'Jest', value: 'jest' }
  ],
  javascript: [
    { name: 'Vitest (Fast ESM Native Testing Framework)', value: 'vitest' },
    { name: 'Jest', value: 'jest' }
  ]
};

export function generateGovernanceConfig(config: GherkinAIConfig, workspaceDir: string = process.cwd()): string {
  const lang = (config.stack.language || '').toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();

  const prohibitedImports: Record<string, string[]> = {};
  const allowedPaths: string[] = ['specs/**', 'tests/**', 'generated-specs/**'];
  const requireHumanApprovalOn: string[] = ['docker-compose.yml'];

  // Backend / Service Paths & Imports
  allowedPaths.push('src/**', 'app/**', 'public/**', 'views/**', 'controllers/**', 'domain/**');

  if (lang === 'java' || framework.includes('spring')) {
    prohibitedImports['java'] = ['org.springframework.beans.factory.annotation.Autowired on fields (use constructor injection)', 'java.sql.Statement without PreparedStatement'];
    requireHumanApprovalOn.push('pom.xml', 'build.gradle', 'application.yml', 'schema.sql');
  } else if (lang === 'csharp' || framework.includes('aspnet') || framework.includes('dotnet')) {
    prohibitedImports['csharp'] = ['System.Data.SqlClient unparameterized queries', 'Direct HttpContext coupling in domain layer'];
    requireHumanApprovalOn.push('*.csproj', 'appsettings.json', 'Program.cs', 'migrations/**');
  } else if (lang === 'python' || framework.includes('django') || framework.includes('fastapi')) {
    prohibitedImports['python'] = ['eval()', 'exec()', 'os.system() with untrusted input'];
    requireHumanApprovalOn.push('requirements.txt', 'pyproject.toml', 'manage.py');
  } else if (lang === 'ruby' || framework.includes('rails')) {
    prohibitedImports['ruby'] = ['where() raw string interpolation'];
    requireHumanApprovalOn.push('Gemfile', 'config/database.yml', 'db/migrate/**');
  } else if (lang === 'go' || framework.includes('gin') || framework.includes('fiber')) {
    prohibitedImports['go'] = ['ignored_err_check (_ = err)'];
    requireHumanApprovalOn.push('go.mod', 'go.sum');
  } else if (framework === 'native-php' || lang === 'php') {
    prohibitedImports['php'] = ['laravel/framework', 'symfony/symfony', 'illuminate/*'];
    requireHumanApprovalOn.push('schema.sql', 'migrations/**');
  } else if (lang === 'typescript' || lang === 'javascript') {
    if (framework === 'nestjs') {
      prohibitedImports['typescript'] = ['express (use NestJS abstractions)', 'typeorm inside controllers'];
    }
    requireHumanApprovalOn.push('schema.prisma', 'ormconfig.json', 'package.json');
  }

  // Frontend Independent Stack Guardrails (if configured)
  if (config.frontendStack && config.frontendStack.framework !== 'none') {
    const feLang = config.frontendStack.language || 'javascript';
    allowedPaths.push('frontend/**', 'src/components/**', 'src/views/**', 'public/**', 'cypress/**', 'e2e/**');
    prohibitedImports[feLang] = [
      ...(prohibitedImports[feLang] || []),
      'express', 'pg', 'mysql2', 'prisma', 'child_process', 'fs'
    ];
    requireHumanApprovalOn.push(
      'package.json',
      'vite.config.ts',
      'webpack.config.js',
      'cypress.config.js',
      'cypress.config.ts',
      'vitest.config.ts',
      'playwright.config.ts'
    );
  }

  const governanceYaml = YAML.stringify({
    version: '1.0',
    projectName: config.projectName,
    allowedPaths: Array.from(new Set(allowedPaths)),
    protectedPaths: [
      '.env*',
      'docker-compose.yml',
      '**/secrets.*',
      'node_modules/**',
      'vendor/**',
      '.git/**'
    ],
    maxFilesPerTask: 12,
    prohibitedImports,
    requireHumanApprovalOn: Array.from(new Set(requireHumanApprovalOn))
  });

  const targetPath = path.join(workspaceDir, '.ghkgovernance.yaml');
  fs.writeFileSync(targetPath, governanceYaml, 'utf8');
  return targetPath;
}

export async function handleInitCommand(options?: {
  enterprise?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  projectName?: string;
  architecture?: string;
  language?: string;
  framework?: string;
  orm?: string;
  database?: string;
  validation?: string;
  messaging?: string;
  testing?: string;
  frontendFramework?: string;
  frontendLanguage?: string;
  frontendBundler?: string;
  frontendUnitTesting?: string;
  frontendE2eTesting?: string;
  outputDir?: string;
}): Promise<void> {
  logger.banner();
  logger.info('Initializing new gherkin-ai project configuration...');
  
  if (options?.enterprise) {
    logger.info('Enterprise mode active: Generating .gherkin-ai/constitution.yaml');
    generateConstitution();
  }

  const isNonInteractive = options?.yes || options?.nonInteractive || process.env.GHK_NON_INTERACTIVE === 'true' || process.env.CI === 'true';

  if (isNonInteractive) {
    logger.info('Running in non-interactive mode. Using default configuration.');
  }

  // Step 1: Core Project Identity & Architecture
  const step1 = await promptOrFallback([
    {
      type: 'input',
      name: 'projectName',
      message: 'What is your project name?',
      default: options?.projectName || defaultConfig.projectName
    },
    {
      type: 'list',
      name: 'architecture',
      message: 'Select primary software architecture:',
      choices: [
        { name: 'Monolith Architecture (MVC / Fullstack Monolithic)', value: 'monolith' },
        { name: 'Hexagonal Architecture (Ports & Adapters)', value: 'hexagonal' },
        { name: 'Domain-Driven Design (DDD)', value: 'ddd' },
        { name: 'Clean Architecture', value: 'clean' },
        { name: 'CQRS + Event Sourcing', value: 'cqrs' },
        { name: 'API REST Architecture (Stateless Service)', value: 'api-rest' },
        { name: 'Microservices Architecture', value: 'microservices' }
      ],
      default: options?.architecture || 'monolith'
    },
    {
      type: 'list',
      name: 'language',
      message: 'Select Backend programming language / runtime:',
      choices: [
        { name: 'PHP (PHP 8.3+)', value: 'php' },
        { name: 'TypeScript (Node.js)', value: 'typescript' },
        { name: 'JavaScript (Node.js)', value: 'javascript' },
        { name: 'Python (Python 3.11+)', value: 'python' },
        { name: 'Java (Java 17/21)', value: 'java' },
        { name: 'C# (.NET 8+)', value: 'csharp' },
        { name: 'Go (Golang)', value: 'go' },
        { name: 'Ruby (Ruby 3+)', value: 'ruby' }
      ],
      default: options?.language || 'php'
    }
  ], options);

  const backendLang = step1.language || options?.language || 'php';

  // Step 2: Contextual Framework, ORM, Validation & Testing Choices based strictly on Backend Language
  const availableFrameworks = FRAMEWORKS_BY_LANG[backendLang] || [
    { name: `${backendLang} Default Framework`, value: `${backendLang}-default` }
  ];
  const availableOrms = ORMS_BY_LANG[backendLang] || [
    { name: `${backendLang} Default Persistence`, value: `${backendLang}-orm` }
  ];
  const availableValidations = VALIDATIONS_BY_LANG[backendLang] || [
    { name: `${backendLang} Default Validation`, value: `${backendLang}-val` }
  ];
  const availableTesting = TESTING_BY_LANG[backendLang] || [
    { name: `${backendLang} Default Testing`, value: `${backendLang}-test` }
  ];

  const defaultValidation = availableValidations.some(v => v.value === options?.validation)
    ? options?.validation
    : availableValidations[0].value;

  const defaultTesting = availableTesting.some(t => t.value === options?.testing)
    ? options?.testing
    : availableTesting[0].value;

  const step2 = await promptOrFallback([
    {
      type: 'list',
      name: 'framework',
      message: `Select primary Backend framework for ${backendLang.toUpperCase()}:`,
      choices: availableFrameworks,
      default: availableFrameworks.some(f => f.value === options?.framework) ? options?.framework : availableFrameworks[0].value
    },
    {
      type: 'list',
      name: 'orm',
      message: `Select Backend database ORM / persistence for ${backendLang.toUpperCase()}:`,
      choices: availableOrms,
      default: availableOrms.some(o => o.value === options?.orm) ? options?.orm : availableOrms[0].value
    },
    {
      type: 'list',
      name: 'database',
      message: 'Select primary database engine:',
      choices: ['mysql', 'postgresql', 'mongodb', 'sqlite', 'redis'],
      default: options?.database || 'mysql'
    },
    {
      type: 'list',
      name: 'validation',
      message: `Select Backend validation library for ${backendLang.toUpperCase()}:`,
      choices: availableValidations,
      default: defaultValidation
    },
    {
      type: 'list',
      name: 'messaging',
      message: 'Select event broker / messaging:',
      choices: ['none', 'native-events', 'rabbitmq', 'kafka', 'sqs', 'redis-pubsub'],
      default: options?.messaging || (step1.architecture === 'monolith' ? 'none' : 'rabbitmq')
    },
    {
      type: 'list',
      name: 'testing',
      message: `Select Backend testing framework for ${backendLang.toUpperCase()}:`,
      choices: availableTesting,
      default: defaultTesting
    }
  ], options);

  // Step 3: Independent Frontend Stack Configuration (for Monolith / Dual-Stack)
  let frontendAnswers: any = { framework: 'none', language: 'javascript', bundler: 'vite', unitTesting: 'vitest', e2eTesting: 'cypress' };

  if (!isNonInteractive) {
    const askFrontend = await promptOrFallback([
      {
        type: 'confirm',
        name: 'hasFrontend',
        message: 'Do you want to configure an independent Frontend / UI Stack?',
        default: true
      }
    ], options);

    if (askFrontend.hasFrontend) {
      frontendAnswers = await promptOrFallback([
        {
          type: 'list',
          name: 'framework',
          message: 'Select Frontend Framework / Library:',
          choices: [
            { name: 'Vanilla Modular JavaScript (Native ES Modules / Vite)', value: 'vanilla-js' },
            { name: 'React (SPA / Modern UI)', value: 'react' },
            { name: 'Vue.js (Composition API)', value: 'vue' },
            { name: 'Angular (TypeScript Framework)', value: 'angular' },
            { name: 'Svelte', value: 'svelte' }
          ],
          default: options?.frontendFramework || 'vanilla-js'
        },
        {
          type: 'list',
          name: 'language',
          message: 'Select Frontend Language (Crucial for Guardrails):',
          choices: [
            { name: 'TypeScript (Strict Type Safety)', value: 'typescript' },
            { name: 'JavaScript (Native ES Modules)', value: 'javascript' }
          ],
          default: options?.frontendLanguage || 'javascript'
        },
        {
          type: 'list',
          name: 'bundler',
          message: 'Select Frontend Bundler:',
          choices: ['vite', 'webpack', 'esbuild', 'none'],
          default: options?.frontendBundler || 'vite'
        },
        {
          type: 'list',
          name: 'unitTesting',
          message: 'Select Frontend Unit / Component Testing Framework:',
          choices: [
            { name: 'Vitest (Fast ESM Native Unit Testing)', value: 'vitest' },
            { name: 'Jest', value: 'jest' },
            { name: 'None', value: 'none' }
          ],
          default: options?.frontendUnitTesting || 'vitest'
        },
        {
          type: 'list',
          name: 'e2eTesting',
          message: 'Select Frontend E2E / Integration Testing Framework (Complementary):',
          choices: [
            { name: 'Cypress (E2E Test Runner)', value: 'cypress' },
            { name: 'Playwright (Cross-Browser E2E Automation)', value: 'playwright' },
            { name: 'None', value: 'none' }
          ],
          default: options?.frontendE2eTesting || 'cypress'
        }
      ], options);
    }
  } else if (options?.frontendFramework) {
    frontendAnswers = {
      framework: options.frontendFramework,
      language: options.frontendLanguage || 'javascript',
      bundler: options.frontendBundler || 'vite',
      unitTesting: options.frontendUnitTesting || 'vitest',
      e2eTesting: options.frontendE2eTesting || 'cypress'
    };
  }

  // Step 4: Governance & Output Directory Options
  const step4 = await promptOrFallback([
    {
      type: 'confirm',
      name: 'enableGovernance',
      message: 'Initialize Enterprise Agent Guardrails (.ghkgovernance.yaml)?',
      default: true
    },
    {
      type: 'input',
      name: 'outputDir',
      message: 'Specify directory for generated contracts and prompts:',
      default: options?.outputDir || './generated-specs'
    }
  ], options);

  const newConfig: GherkinAIConfig = {
    projectName: options?.projectName || step1.projectName,
    architecture: options?.architecture || step1.architecture,
    stack: {
      language: options?.language || step1.language,
      framework: options?.framework || step2.framework,
      orm: options?.orm || step2.orm,
      database: options?.database || step2.database,
      validation: options?.validation || step2.validation,
      auth: 'jwt-bcrypt',
      messaging: options?.messaging || step2.messaging,
      testing: options?.testing || step2.testing
    },
    frontendStack: frontendAnswers.framework !== 'none' ? {
      framework: frontendAnswers.framework,
      language: frontendAnswers.language,
      bundler: frontendAnswers.bundler,
      unitTesting: frontendAnswers.unitTesting,
      e2eTesting: frontendAnswers.e2eTesting
    } : undefined,
    rules: defaultConfig.rules,
    outputDir: options?.outputDir || step4.outputDir
  };

  saveConfig(newConfig);
  logger.success('Successfully created gherkin-ai.config.json');

  if (step4.enableGovernance || options?.enterprise || isNonInteractive) {
    const govPath = generateGovernanceConfig(newConfig);
    logger.success(`Successfully created Agent Governance Policy: ${govPath}`);
  }

  ensureGitignore(process.cwd());

  logger.info('Next step: Run "ghk generate --feature ./your-feature.feature"');
}
