/* ==========================================================================
   gherkin-ai-cli - Multi-Language Stack & Architecture Auto-Detector
   ========================================================================== */

import path from 'path';
import { fileExistsSync, readFileSync } from '../utils/file-system';
import { GherkinAIConfig, defaultConfig } from './config';

export function detectExistingStack(rootDir: string = process.cwd()): GherkinAIConfig {
  const detected: GherkinAIConfig = {
    projectName: path.basename(rootDir) || 'existing-project',
    projectMode: 'brownfield',
    architecture: 'hexagonal',
    stack: { ...defaultConfig.stack },
    rules: { ...defaultConfig.rules },
    outputDir: './src'
  };

  const composerJsonPath = path.join(rootDir, 'composer.json');
  const artisanPath = path.join(rootDir, 'artisan');
  const goModPath = path.join(rootDir, 'go.mod');
  const pyProjectPath = path.join(rootDir, 'pyproject.toml');
  const reqTxtPath = path.join(rootDir, 'requirements.txt');
  const managePyPath = path.join(rootDir, 'manage.py');
  const pomXmlPath = path.join(rootDir, 'pom.xml');
  const buildGradlePath = path.join(rootDir, 'build.gradle');
  const packageJsonPath = path.join(rootDir, 'package.json');

  // 1. PHP / Laravel Stack Detection (Checks artisan & composer.json first)
  if (fileExistsSync(artisanPath) || fileExistsSync(composerJsonPath)) {
    detected.stack.language = 'php';
    detected.stack.framework = 'laravel';
    detected.stack.orm = 'eloquent';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'laravel-validation';
    detected.stack.auth = 'laravel-sanctum';
    detected.stack.testing = 'phpunit';
    detected.architecture = 'monolith';

    if (fileExistsSync(composerJsonPath)) {
      try {
        const raw = readFileSync(composerJsonPath);
        const composer = JSON.parse(raw);
        if (composer.name) detected.projectName = composer.name.split('/')[1] || composer.name;

        const reqs = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
        if (reqs['pestphp/pest']) detected.stack.testing = 'pest';
        if (reqs['symfony/symfony']) {
          detected.stack.framework = 'symfony';
          detected.stack.orm = 'doctrine';
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  }
  // 2. Python Stack Detection (Django / FastAPI / Flask)
  else if (fileExistsSync(managePyPath) || fileExistsSync(pyProjectPath) || fileExistsSync(reqTxtPath)) {
    detected.stack.language = 'python';
    detected.stack.testing = 'pytest';
    detected.stack.database = 'postgresql';

    if (fileExistsSync(managePyPath)) {
      detected.stack.framework = 'django';
      detected.stack.orm = 'django-orm';
      detected.stack.validation = 'django-forms';
    } else {
      detected.stack.framework = 'fastapi';
      detected.stack.orm = 'sqlalchemy';
      detected.stack.validation = 'pydantic';
    }
  }
  // 3. Go Stack Detection
  else if (fileExistsSync(goModPath)) {
    detected.stack.language = 'go';
    detected.stack.framework = 'gin';
    detected.stack.orm = 'gorm';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'validator-v10';
    detected.stack.testing = 'testing';
  }
  // 4. Java / Kotlin Stack Detection
  else if (fileExistsSync(pomXmlPath) || fileExistsSync(buildGradlePath)) {
    detected.stack.language = 'java';
    detected.stack.framework = 'spring-boot';
    detected.stack.orm = 'hibernate';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'jakarta-validation';
    detected.stack.testing = 'junit';
  }
  // 5. Node.js / TypeScript / JavaScript Stack Detection
  else if (fileExistsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath);
      const pkg = JSON.parse(raw);
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (pkg.name) detected.projectName = pkg.name;

      // Language
      if (allDeps['typescript'] || fileExistsSync(path.join(rootDir, 'tsconfig.json'))) {
        detected.stack.language = 'typescript';
      } else {
        detected.stack.language = 'javascript';
      }

      // Framework
      if (allDeps['@nestjs/core']) detected.stack.framework = 'nestjs';
      else if (allDeps['express']) detected.stack.framework = 'express';
      else if (allDeps['fastify']) detected.stack.framework = 'fastify';
      else if (allDeps['next']) detected.stack.framework = 'nextjs';
      else detected.stack.framework = 'express';

      // ORM / Persistence
      if (allDeps['prisma'] || fileExistsSync(path.join(rootDir, 'prisma', 'schema.prisma'))) detected.stack.orm = 'prisma';
      else if (allDeps['typeorm']) detected.stack.orm = 'typeorm';
      else if (allDeps['sequelize']) detected.stack.orm = 'sequelize';
      else if (allDeps['mongoose']) detected.stack.orm = 'mongoose';

      // Database
      if (allDeps['pg'] || allDeps['postgres'] || allDeps['@prisma/client']) detected.stack.database = 'postgresql';
      else if (allDeps['mongodb'] || allDeps['mongoose']) detected.stack.database = 'mongodb';
      else if (allDeps['redis'] || allDeps['ioredis']) detected.stack.database = 'redis';

      // Validation
      if (allDeps['zod']) detected.stack.validation = 'zod';
      else if (allDeps['class-validator']) detected.stack.validation = 'class-validator';
      else if (allDeps['joi']) detected.stack.validation = 'joi';

      // Testing
      if (allDeps['jest']) detected.stack.testing = 'jest';
      else if (allDeps['vitest']) detected.stack.testing = 'vitest';

    } catch {
      // Ignore JSON parse errors
    }
  }

  // 6. Architecture Style Heuristic Detection
  if (fileExistsSync(path.join(rootDir, 'src', 'domain')) && fileExistsSync(path.join(rootDir, 'src', 'ports'))) {
    detected.architecture = 'hexagonal';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'events')) && fileExistsSync(path.join(rootDir, 'src', 'commands'))) {
    detected.architecture = 'cqrs';
  } else if (fileExistsSync(path.join(rootDir, 'serverless.yml'))) {
    detected.architecture = 'serverless';
  } else if (fileExistsSync(path.join(rootDir, 'app', 'Http', 'Controllers')) || fileExistsSync(artisanPath)) {
    detected.architecture = 'monolith';
    detected.outputDir = './app';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'modules'))) {
    detected.architecture = 'modular';
  }

  return detected;
}
