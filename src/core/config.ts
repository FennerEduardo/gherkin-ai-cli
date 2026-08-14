/* ==========================================================================
   gherkin-ai-cli - Configuration Schema & Reader
   ========================================================================== */

import path from 'path';
import { fileExistsSync, readFileSync, writeFileSync } from '../utils/file-system';

export interface GherkinAIConfig {
  projectName: string;
  projectMode?: 'greenfield' | 'brownfield';
  architecture: 'ddd' | 'hexagonal' | 'clean' | 'cqrs' | 'microservices' | 'monolith' | 'modular' | 'api-rest' | 'serverless' | 'event-driven';
  stack: {
    language: string;
    framework: string;
    orm: string;
    database: string;
    validation: string;
    auth: string;
    messaging?: string;
    testing: string;
  };
  rules: {
    bcryptCostFactor?: number;
    jwtTtlSeconds?: number;
    strictLayerBoundaries?: boolean;
    coverageTarget?: number;
  };
  outputDir: string;
}

export const defaultConfig: GherkinAIConfig = {
  projectName: 'my-gherkin-service',
  projectMode: 'greenfield',
  architecture: 'hexagonal',
  stack: {
    language: 'typescript',
    framework: 'nestjs',
    orm: 'prisma',
    database: 'postgresql',
    validation: 'zod',
    auth: 'jwt-bcrypt',
    messaging: 'rabbitmq',
    testing: 'jest'
  },
  rules: {
    bcryptCostFactor: 12,
    jwtTtlSeconds: 3600,
    strictLayerBoundaries: true,
    coverageTarget: 85
  },
  outputDir: './generated-specs'
};

export function loadConfig(configPath?: string): GherkinAIConfig {
  const targetPath = configPath || path.join(process.cwd(), 'gherkin-ai.config.json');
  
  if (!fileExistsSync(targetPath)) {
    return defaultConfig;
  }
  
  try {
    const raw = readFileSync(targetPath);
    const parsed = JSON.parse(raw);
    return { ...defaultConfig, ...parsed, stack: { ...defaultConfig.stack, ...(parsed.stack || {}) } };
  } catch (err) {
    throw new Error(`Failed to parse config file at ${targetPath}: ${(err as Error).message}`);
  }
}

export function saveConfig(config: GherkinAIConfig, configPath?: string): void {
  const targetPath = configPath || path.join(process.cwd(), 'gherkin-ai.config.json');
  writeFileSync(targetPath, JSON.stringify(config, null, 2));
}
