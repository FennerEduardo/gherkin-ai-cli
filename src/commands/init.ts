import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import inquirer from 'inquirer';
import { defaultConfig, saveConfig, GherkinAIConfig } from '../core/config';
import { generateConstitution } from '../core/constitution';
import { logger } from '../utils/logger';

export function generateGovernanceConfig(config: GherkinAIConfig, workspaceDir: string = process.cwd()): string {
  const lang = (config.stack.language || '').toLowerCase();
  const framework = (config.stack.framework || '').toLowerCase();

  const prohibitedImports: Record<string, string[]> = {};
  const allowedPaths: string[] = ['specs/**', 'tests/**', 'generated-specs/**'];
  const requireHumanApprovalOn: string[] = ['docker-compose.yml'];

  // 1. Frontend Stacks (React, Next, Vue, Angular, Svelte, Ionic)
  if (framework.includes('react') || framework.includes('next') || framework.includes('vue') || framework.includes('angular') || framework.includes('svelte')) {
    allowedPaths.push('src/**', 'public/**', 'components/**', 'pages/**', 'app/**', 'views/**');
    prohibitedImports['javascript'] = ['express', 'pg', 'mysql2', 'prisma', 'child_process', 'fs'];
    requireHumanApprovalOn.push('package.json', 'vite.config.ts', 'next.config.js', 'angular.json');
  } 
  // 2. Mobile Stacks (Flutter, Swift, Kotlin, React Native)
  else if (framework.includes('flutter') || framework.includes('react-native') || framework.includes('ios') || framework.includes('android')) {
    allowedPaths.push('lib/**', 'src/**', 'App/**', 'ios/Runner/**', 'android/app/**');
    prohibitedImports[lang || 'mobile'] = ['child_process', 'raw_system_exec'];
    requireHumanApprovalOn.push('pubspec.yaml', 'AndroidManifest.xml', 'Info.plist', 'build.gradle');
  } 
  // 3. Backend / Enterprise Monolith Stacks (Java, C#, Python, Go, Ruby, PHP, Node)
  else {
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
  }

  const governanceYaml = YAML.stringify({
    version: '1.0',
    projectName: config.projectName,
    allowedPaths,
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
    requireHumanApprovalOn
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
  outputDir?: string;
}): Promise<void> {
  logger.banner();
  logger.info('Initializing new gherkin-ai project configuration...');
  
  if (options?.enterprise) {
    logger.info('Enterprise mode active: Generating .gherkin-ai/constitution.yaml');
    generateConstitution();
  }

  let answers: any = {};
  const isNonInteractive = options?.yes || options?.nonInteractive || process.env.GHK_NON_INTERACTIVE === 'true' || process.env.CI === 'true';

  const { promptOrFallback } = require('../utils/i18n-cli');
  
  if (isNonInteractive) {
    logger.info('Running in non-interactive mode. Using default configuration.');
  }

  answers = await promptOrFallback([
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
        { name: 'Hexagonal Architecture (Ports & Adapters)', value: 'hexagonal' },
        { name: 'Domain-Driven Design (DDD)', value: 'ddd' },
        { name: 'Clean Architecture', value: 'clean' },
        { name: 'CQRS + Event Sourcing', value: 'cqrs' },
        { name: 'Microservices Architecture', value: 'microservices' },
        { name: 'Monolith Architecture (MVC / Monolithic)', value: 'monolith' },
        { name: 'API REST Architecture (Stateless Service)', value: 'api-rest' }
      ],
      default: options?.architecture || 'hexagonal'
    },
    {
      type: 'list',
      name: 'language',
      message: 'Select programming language / runtime:',
      choices: ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'php', 'ruby', 'rust', 'swift', 'dart'],
      default: options?.language || 'typescript'
    },
    {
      type: 'list',
      name: 'framework',
      message: 'Select primary framework:',
      choices: ['nestjs', 'express', 'fastify', 'spring-boot', 'fastapi', 'aspnet', 'native-php', 'laravel', 'rails', 'gin', 'django'],
      default: options?.framework || 'nestjs'
    },
    {
      type: 'list',
      name: 'orm',
      message: 'Select database ORM / persistence:',
      choices: ['prisma', 'drizzle', 'typeorm', 'sqlalchemy', 'pdo', 'eloquent', 'gorm', 'active-record'],
      default: options?.orm || 'prisma'
    },
    {
      type: 'list',
      name: 'database',
      message: 'Select primary database engine:',
      choices: ['postgresql', 'mysql', 'mongodb', 'redis', 'sqlite'],
      default: options?.database || 'postgresql'
    },
    {
      type: 'list',
      name: 'validation',
      message: 'Select validation library:',
      choices: ['zod', 'native-php-filter', 'valitron', 'pydantic', 'jakarta-validation', 'custom'],
      default: options?.validation || (options?.language === 'php' ? 'native-php-filter' : 'zod')
    },
    {
      type: 'list',
      name: 'messaging',
      message: 'Select event broker / messaging:',
      choices: ['none', 'native-events', 'rabbitmq', 'kafka', 'sqs', 'redis-pubsub'],
      default: options?.messaging || (options?.architecture === 'monolith' ? 'none' : 'rabbitmq')
    },
    {
      type: 'list',
      name: 'testing',
      message: 'Select testing framework:',
      choices: ['vitest', 'jest', 'phpunit', 'pytest', 'junit', 'xunit'],
      default: options?.testing || 'vitest'
    },
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
    projectName: options?.projectName || answers.projectName,
    architecture: options?.architecture || answers.architecture,
    stack: {
      language: options?.language || answers.language,
      framework: options?.framework || answers.framework,
      orm: options?.orm || answers.orm,
      database: options?.database || answers.database,
      validation: options?.validation || answers.validation || 'zod',
      auth: 'jwt-bcrypt',
      messaging: options?.messaging || answers.messaging || 'none',
      testing: options?.testing || answers.testing || 'vitest'
    },
    rules: defaultConfig.rules,
    outputDir: options?.outputDir || answers.outputDir
  };

  saveConfig(newConfig);
  logger.success('Successfully created gherkin-ai.config.json');

  if (answers.enableGovernance || options?.enterprise || isNonInteractive) {
    const govPath = generateGovernanceConfig(newConfig);
    logger.success(`Successfully created Agent Governance Policy: ${govPath}`);
  }

  logger.info('Next step: Run "ghk generate --feature ./your-feature.feature"');
}
