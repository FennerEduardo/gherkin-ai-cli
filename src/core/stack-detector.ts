/* ==========================================================================
   gherkin-ai-cli - Stack & Architecture Auto-Detector for Existing Projects
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

  const packageJsonPath = path.join(rootDir, 'package.json');
  const pyProjectPath = path.join(rootDir, 'pyproject.toml');
  const reqTxtPath = path.join(rootDir, 'requirements.txt');
  const pomXmlPath = path.join(rootDir, 'pom.xml');

  // 1. Node.js / TypeScript Stack Detection
  if (fileExistsSync(packageJsonPath)) {
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
  // 2. Python Stack Detection
  else if (fileExistsSync(pyProjectPath) || fileExistsSync(reqTxtPath)) {
    detected.stack.language = 'python';
    detected.stack.framework = 'fastapi';
    detected.stack.orm = 'sqlalchemy';
    detected.stack.validation = 'pydantic';
    detected.stack.testing = 'pytest';
  } 
  // 3. Java Stack Detection
  else if (fileExistsSync(pomXmlPath)) {
    detected.stack.language = 'java';
    detected.stack.framework = 'spring-boot';
    detected.stack.orm = 'hibernate';
    detected.stack.validation = 'jakarta-validation';
    detected.stack.testing = 'junit';
  }

  // 4. Architecture Style Heuristic Detection
  if (fileExistsSync(path.join(rootDir, 'src', 'domain')) && fileExistsSync(path.join(rootDir, 'src', 'ports'))) {
    detected.architecture = 'hexagonal';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'events')) && fileExistsSync(path.join(rootDir, 'src', 'commands'))) {
    detected.architecture = 'cqrs';
  } else if (fileExistsSync(path.join(rootDir, 'serverless.yml'))) {
    detected.architecture = 'serverless';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'modules'))) {
    detected.architecture = 'modular';
  }

  return detected;
}
