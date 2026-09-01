/* ==========================================================================
   gherkin-ai-cli - Multi-Language Stack & Architecture Auto-Detector
   Supports: PHP/Laravel, Ruby/Rails, C#/.NET, Java/Spring, Python/Django/FastAPI,
             Go, Node/Nest/Express, Angular, Ionic, React, Vue, Svelte, Flutter.
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

  const gemfilePath = path.join(rootDir, 'Gemfile');
  const composerJsonPath = path.join(rootDir, 'composer.json');
  const artisanPath = path.join(rootDir, 'artisan');
  const goModPath = path.join(rootDir, 'go.mod');
  const pyProjectPath = path.join(rootDir, 'pyproject.toml');
  const reqTxtPath = path.join(rootDir, 'requirements.txt');
  const managePyPath = path.join(rootDir, 'manage.py');
  const pomXmlPath = path.join(rootDir, 'pom.xml');
  const buildGradlePath = path.join(rootDir, 'build.gradle');
  const angularJsonPath = path.join(rootDir, 'angular.json');
  const pubspecPath = path.join(rootDir, 'pubspec.yaml');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const cargoTomlPath = path.join(rootDir, 'Cargo.toml');
  const swiftPackage = path.join(rootDir, 'Package.swift');
  const xcodeProj = path.join(rootDir, 'project.pbxproj');

  // 1. Ruby on Rails Stack Detection
  if (fileExistsSync(gemfilePath)) {
    detected.stack.language = 'ruby';
    detected.stack.framework = 'rails';
    detected.stack.orm = 'active-record';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'active-model-validations';
    detected.stack.testing = 'rspec';
    detected.architecture = 'monolith';
    detected.outputDir = './app';

    try {
      const gemContent = readFileSync(gemfilePath);
      if (gemContent.includes('rspec-rails')) detected.stack.testing = 'rspec';
      else detected.stack.testing = 'minitest';
    } catch {
      // Ignore
    }
  }
  // 2. C# / .NET / ASP.NET Core Stack Detection
  else if (fileExistsSync(path.join(rootDir, 'Program.cs')) || fileExistsSync(path.join(rootDir, 'appsettings.json'))) {
    detected.stack.language = 'csharp';
    detected.stack.framework = 'dotnet-aspnetcore';
    detected.stack.orm = 'entity-framework-core';
    detected.stack.database = 'sql-server';
    detected.stack.validation = 'fluent-validation';
    detected.stack.testing = 'xunit';
  }
  // 3. PHP / Laravel Stack Detection
  else if (fileExistsSync(artisanPath) || fileExistsSync(composerJsonPath)) {
    detected.stack.language = 'php';
    detected.stack.framework = 'laravel';
    detected.stack.orm = 'eloquent';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'laravel-validation';
    detected.stack.auth = 'laravel-sanctum';
    detected.stack.testing = 'phpunit';
    detected.architecture = 'monolith';
    detected.outputDir = './app';

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
        // Ignore
      }
    }
  }
  // 4. Flutter / Dart Mobile Detection
  else if (fileExistsSync(pubspecPath)) {
    detected.stack.language = 'dart';
    detected.stack.framework = 'flutter';
    detected.stack.orm = 'sqflite';
    detected.stack.database = 'sqlite';
    detected.stack.validation = 'form-validation';
    detected.stack.testing = 'flutter_test';
    detected.outputDir = './lib';
  }
  // 5. Python Stack Detection (Django / FastAPI / Flask)
  else if (fileExistsSync(managePyPath) || fileExistsSync(pyProjectPath) || fileExistsSync(reqTxtPath)) {
    detected.stack.language = 'python';
    detected.stack.testing = 'pytest';
    detected.stack.database = 'postgresql';

    if (fileExistsSync(managePyPath)) {
      detected.stack.framework = 'django';
      detected.stack.orm = 'django-orm';
      detected.stack.validation = 'django-forms';
    } else {
      try {
        const reqContent = readFileSync(reqTxtPath);
        if (reqContent.includes('flask')) detected.stack.framework = 'flask';
        else detected.stack.framework = 'fastapi';
        if (reqContent.includes('langchain') || reqContent.includes('llama-index')) detected.stack.aiEngine = 'langchain';
      } catch {
        detected.stack.framework = 'fastapi';
      }
      detected.stack.orm = 'sqlalchemy';
      detected.stack.validation = 'pydantic';
    }
  }
  // 6. Go Stack Detection
  else if (fileExistsSync(goModPath)) {
    detected.stack.language = 'go';
    detected.stack.orm = 'gorm';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'validator-v10';
    detected.stack.testing = 'testing';
    
    try {
      const modContent = readFileSync(goModPath);
      if (modContent.includes('github.com/gofiber/fiber')) detected.stack.framework = 'fiber';
      else if (modContent.includes('github.com/labstack/echo')) detected.stack.framework = 'echo';
      else detected.stack.framework = 'gin';
    } catch {
      detected.stack.framework = 'gin';
    }
  }
  // 6.5. Rust Stack Detection
  else if (fileExistsSync(cargoTomlPath)) {
    detected.stack.language = 'rust';
    detected.stack.framework = 'axum';
    detected.stack.orm = 'diesel-or-sqlx';
    detected.stack.database = 'postgresql';
    detected.stack.testing = 'cargo-test';
    
    try {
      const tomlContent = readFileSync(cargoTomlPath);
      if (tomlContent.includes('actix-web')) detected.stack.framework = 'actix-web';
      if (tomlContent.includes('rocket')) detected.stack.framework = 'rocket';
      if (tomlContent.includes('tauri')) {
        detected.stack.framework = 'tauri';
        detected.architecture = 'desktop';
      }
    } catch {}
  }
  // 7. Java / Kotlin Stack Detection
  else if (fileExistsSync(pomXmlPath) || fileExistsSync(buildGradlePath)) {
    detected.stack.language = 'java';
    detected.stack.framework = 'spring-boot';
    detected.stack.orm = 'hibernate';
    detected.stack.database = 'postgresql';
    detected.stack.validation = 'jakarta-validation';
    detected.stack.testing = 'junit';
    
    try {
      const gradleContent = fileExistsSync(buildGradlePath) ? readFileSync(buildGradlePath) : '';
      if (gradleContent.includes('org.jetbrains.kotlin')) {
        detected.stack.language = 'kotlin';
      }
      if (gradleContent.includes('com.android.application')) {
        detected.stack.framework = 'android-native';
        detected.architecture = 'modular';
        detected.outputDir = './app/src/main/java';
      }
    } catch {}
  }
  // 7.5. Swift / iOS Detection
  else if (fileExistsSync(swiftPackage) || fileExistsSync(xcodeProj)) {
    detected.stack.language = 'swift';
    detected.stack.framework = 'ios-native';
    detected.stack.orm = 'core-data';
    detected.stack.database = 'sqlite';
    detected.architecture = 'modular';
    detected.outputDir = './';
  }
  // 8. Node.js / Frontend / Ionic / Angular / React / Vue Stack Detection
  else if (fileExistsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath);
      const pkg = JSON.parse(raw);
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (pkg.name) detected.projectName = pkg.name;

      // Monorepo / Workspaces Detection
      if (pkg.workspaces || fileExistsSync(path.join(rootDir, 'nx.json')) || fileExistsSync(path.join(rootDir, 'lerna.json')) || fileExistsSync(path.join(rootDir, 'pnpm-workspace.yaml'))) {
        detected.projectMode = 'monorepo';
        detected.architecture = 'monorepo-workspaces';
      }

      // Deep Dependencies (Message Brokers, API Protocols, AI)
      if (allDeps['graphql'] || allDeps['@apollo/server']) detected.stack.language += ' + GraphQL';
      if (allDeps['kafkajs']) detected.stack.messaging = 'kafka';
      if (allDeps['amqplib']) detected.stack.messaging = 'rabbitmq';
      if (allDeps['@grpc/grpc-js']) detected.stack.language += ' + gRPC';
      if (allDeps['langchain'] || allDeps['pinecone-client'] || allDeps['@pinecone-database/pinecone']) {
        detected.stack.aiEngine = 'langchain-pinecone';
      }

      // Language Detection (TypeScript if angular, tsconfig or typescript dep exists)
      if (allDeps['typescript'] || fileExistsSync(path.join(rootDir, 'tsconfig.json')) || fileExistsSync(angularJsonPath) || allDeps['@angular/core']) {
        detected.stack.language = 'typescript';
      } else {
        detected.stack.language = 'javascript';
      }

      // Angular / Ionic Frontend Detection
      if (fileExistsSync(angularJsonPath) || allDeps['@angular/core']) {
        if (allDeps['@ionic/angular']) {
          detected.stack.framework = 'ionic-angular';
        } else {
          detected.stack.framework = 'angular';
        }
        detected.stack.orm = 'http-client-rxjs';
        detected.stack.database = 'localstorage-indexeddb';
        detected.stack.validation = 'angular-reactive-forms';
        detected.stack.testing = 'jasmine-karma';
        detected.architecture = 'modular';
        detected.outputDir = './src/app';
      }
      // React Native Detection
      else if (allDeps['react-native']) {
        detected.stack.framework = 'react-native';
        detected.stack.orm = 'async-storage';
        detected.stack.database = 'sqlite-capacitor';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'jest';
        detected.architecture = 'modular';
      }
      // Electron Desktop
      else if (allDeps['electron']) {
        detected.stack.framework = 'electron';
        detected.architecture = 'desktop';
      }
      // React / Next.js Frontend
      else if (allDeps['react'] || allDeps['next']) {
        detected.stack.framework = allDeps['next'] ? 'nextjs' : 'react';
        detected.stack.orm = allDeps['prisma'] ? 'prisma' : 'tanstack-query';
        detected.stack.database = 'postgresql';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'vitest';
      }
      // Vue / Nuxt Frontend
      else if (allDeps['vue'] || allDeps['nuxt']) {
        detected.stack.framework = allDeps['nuxt'] ? 'nuxtjs' : 'vue';
        detected.stack.orm = 'pinia-axios';
        detected.stack.database = 'localstorage';
        detected.stack.validation = 'vee-validate';
        detected.stack.testing = 'vitest';
      }
      // Svelte / Astro / Solid Frontend
      else if (allDeps['svelte'] || allDeps['astro'] || allDeps['solid-js']) {
        detected.stack.framework = allDeps['svelte'] ? 'svelte' : (allDeps['astro'] ? 'astro' : 'solid-js');
        detected.stack.orm = 'fetch-api';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'vitest';
      }
      // Node.js Backend Frameworks (NestJS, Express, Fastify)
      else if (allDeps['@nestjs/core']) {
        detected.stack.framework = 'nestjs';
        detected.stack.orm = allDeps['prisma'] ? 'prisma' : 'typeorm';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'jest';
      } else if (allDeps['fastify']) {
        detected.stack.framework = 'fastify';
        detected.stack.orm = allDeps['prisma'] ? 'prisma' : 'drizzle';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'vitest';
      } else if (allDeps['express']) {
        detected.stack.framework = 'express';
        detected.stack.orm = allDeps['prisma'] ? 'prisma' : 'sequelize';
        detected.stack.validation = 'zod';
        detected.stack.testing = 'jest';
      }

    } catch {
      // Ignore JSON parse errors
    }
  }

  // 9. Architecture Style Heuristic Detection
  if (fileExistsSync(path.join(rootDir, 'src', 'domain')) && fileExistsSync(path.join(rootDir, 'src', 'ports'))) {
    detected.architecture = 'hexagonal';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'events')) && fileExistsSync(path.join(rootDir, 'src', 'commands'))) {
    detected.architecture = 'cqrs';
  } else if (fileExistsSync(path.join(rootDir, 'serverless.yml'))) {
    detected.architecture = 'serverless';
  } else if (fileExistsSync(path.join(rootDir, 'app', 'Http', 'Controllers')) || fileExistsSync(artisanPath)) {
    detected.architecture = 'monolith';
  } else if (fileExistsSync(path.join(rootDir, 'src', 'modules')) || fileExistsSync(path.join(rootDir, 'src', 'app'))) {
    detected.architecture = 'modular';
  }

  return detected;
}
