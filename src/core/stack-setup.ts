/* ==========================================================================
   gherkin-ai-cli - Stack Setup & Dependency Checker
   
   Detects missing dependencies declared in gherkin-ai.config.json against
   the project's actual package.json / build files, and suggests or executes
   the install commands needed to close the gap.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { GherkinAIConfig } from './config';

export interface MissingDependency {
  name: string;
  installCommand: string;
  reason: string;
  category: 'orm' | 'validation' | 'testing' | 'database' | 'messaging' | 'auth' | 'framework';
}

export interface StackSetupResult {
  hasMissing: boolean;
  missing: MissingDependency[];
  suggestions: string[];
}

// Maps config values to their actual npm package names
const DEPENDENCY_MAP: Record<string, { packages: string[]; devPackages?: string[]; category: MissingDependency['category'] }> = {
  // ORMs
  'prisma':         { packages: ['@prisma/client'], devPackages: ['prisma'], category: 'orm' },
  'typeorm':        { packages: ['typeorm', 'reflect-metadata'], category: 'orm' },
  'drizzle':        { packages: ['drizzle-orm'], devPackages: ['drizzle-kit'], category: 'orm' },
  'sequelize':      { packages: ['sequelize'], category: 'orm' },
  'mongoose':       { packages: ['mongoose'], category: 'orm' },

  // Validation
  'zod':            { packages: ['zod'], category: 'validation' },
  'joi':            { packages: ['joi'], category: 'validation' },
  'class-validator': { packages: ['class-validator', 'class-transformer'], category: 'validation' },
  'yup':            { packages: ['yup'], category: 'validation' },

  // Testing
  'jest':           { packages: [], devPackages: ['jest', '@types/jest', 'ts-jest'], category: 'testing' },
  'vitest':         { packages: [], devPackages: ['vitest'], category: 'testing' },
  'mocha':          { packages: [], devPackages: ['mocha', '@types/mocha', 'chai'], category: 'testing' },
  'playwright':     { packages: [], devPackages: ['@playwright/test'], category: 'testing' },

  // Database drivers
  'postgresql':     { packages: ['pg'], devPackages: ['@types/pg'], category: 'database' },
  'mysql':          { packages: ['mysql2'], category: 'database' },
  'mongodb':        { packages: ['mongodb'], category: 'database' },
  'sqlite':         { packages: ['better-sqlite3'], category: 'database' },

  // Messaging
  'rabbitmq':       { packages: ['amqplib'], devPackages: ['@types/amqplib'], category: 'messaging' },
  'kafka':          { packages: ['kafkajs'], category: 'messaging' },
  'redis':          { packages: ['ioredis'], category: 'messaging' },

  // Auth
  'jwt-bcrypt':     { packages: ['jsonwebtoken', 'bcrypt'], devPackages: ['@types/jsonwebtoken', '@types/bcrypt'], category: 'auth' },
  'jwt':            { packages: ['jsonwebtoken'], devPackages: ['@types/jsonwebtoken'], category: 'auth' },
  'passport':       { packages: ['passport'], devPackages: ['@types/passport'], category: 'auth' },
};

/**
 * Reads the project's package.json and returns the set of installed dependency names.
 */
function getInstalledPackages(projectDir: string): Set<string> {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return new Set();

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    return new Set([...deps, ...devDeps]);
  } catch {
    return new Set();
  }
}

/**
 * Compares config-declared stack against installed packages.
 */
export function detectMissingDependencies(
  config: GherkinAIConfig,
  projectDir: string = process.cwd()
): StackSetupResult {
  const installed = getInstalledPackages(projectDir);
  const missing: MissingDependency[] = [];
  const suggestions: string[] = [];

  // Collect all stack values to check
  const stackValues: { value: string; source: string }[] = [];

  if (config.stack?.orm)        stackValues.push({ value: config.stack.orm, source: 'stack.orm' });
  if (config.stack?.validation) stackValues.push({ value: config.stack.validation, source: 'stack.validation' });
  if (config.stack?.testing)    stackValues.push({ value: config.stack.testing, source: 'stack.testing' });
  if (config.stack?.database)   stackValues.push({ value: config.stack.database, source: 'stack.database' });
  if (config.stack?.messaging)  stackValues.push({ value: config.stack.messaging, source: 'stack.messaging' });
  if (config.stack?.auth)       stackValues.push({ value: config.stack.auth, source: 'stack.auth' });

  for (const { value, source } of stackValues) {
    const entry = DEPENDENCY_MAP[value.toLowerCase()];
    if (!entry) continue;

    const allPkgs = [...entry.packages, ...(entry.devPackages || [])];
    const missingPkgs = allPkgs.filter(pkg => !installed.has(pkg));

    if (missingPkgs.length > 0) {
      const prodPkgs = entry.packages.filter(p => !installed.has(p));
      const devPkgs = (entry.devPackages || []).filter(p => !installed.has(p));

      let installCmd = '';
      if (prodPkgs.length > 0) installCmd += `npm install ${prodPkgs.join(' ')}`;
      if (devPkgs.length > 0) {
        if (installCmd) installCmd += ' && ';
        installCmd += `npm install -D ${devPkgs.join(' ')}`;
      }

      missing.push({
        name: value,
        installCommand: installCmd,
        reason: `Declared in config (${source}) but not found in package.json`,
        category: entry.category
      });

      suggestions.push(installCmd);
    }
  }

  return {
    hasMissing: missing.length > 0,
    missing,
    suggestions
  };
}

/**
 * Executes install commands, or prints them in dry-run mode.
 */
export function executeSetup(
  commands: string[],
  options: { dryRun?: boolean; cwd?: string } = {}
): { success: boolean; output: string } {
  const cwd = options.cwd || process.cwd();

  if (options.dryRun) {
    return {
      success: true,
      output: commands.map(cmd => `[DRY RUN] ${cmd}`).join('\n')
    };
  }

  const outputs: string[] = [];
  for (const cmd of commands) {
    try {
      const output = execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000
      });
      outputs.push(output);
    } catch (err: any) {
      return {
        success: false,
        output: `Failed executing: ${cmd}\n${err.message}`
      };
    }
  }

  return { success: true, output: outputs.join('\n') };
}
