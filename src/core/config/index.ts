/* ==========================================================================
   gherkin-ai-cli - Configuration Schema & Reader
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { writeFileSync } from '../../utils/file-system';
import { GherkinAIConfig, PartialGherkinAIConfig, partialConfigSchema } from './schema';
import { resolveConfig, userConfigPath, LoadOptions, ResolvedConfig } from './loader';

export type { GherkinAIConfig, PartialGherkinAIConfig, LLMSettings, LLMProviderName } from './schema';
export { configSchema, partialConfigSchema, LLM_PROVIDERS, ARCHITECTURES } from './schema';
export { resolveConfig, orgConfigPath, userConfigPath } from './loader';
export type { ResolvedConfig, ConfigLayer, ConfigLayerName, LoadOptions } from './loader';

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
  audit: {
    enabled: true,
    maxEntries: 50,
    persistInGit: false
  },
  designPatterns: [],
  codingRules: [],
  outputDir: './',
  specDir: undefined,
  testCommand: undefined
};

/** Loads the fully resolved configuration (all layers) with provenance and warnings. */
export function loadResolvedConfig(options: LoadOptions = {}): ResolvedConfig {
  return resolveConfig(defaultConfig, options);
}

/**
 * Loads the effective configuration (defaults → organization → user → project → environment).
 * Throws ConfigError (exit code 3) when any layer fails schema validation.
 */
export function loadConfig(configPath?: string): GherkinAIConfig {
  return loadResolvedConfig({ configPath }).config;
}

/**
 * Deep-merges `patch` into the user config (~/.gherkin-ai/config.json or $GHK_USER_CONFIG).
 * Validates the result before writing. Never use this for secrets.
 */
export function updateUserConfig(patch: PartialGherkinAIConfig, env: NodeJS.ProcessEnv = process.env): string {
  const target = userConfigPath(env);
  const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])
        ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>)
        : v;
    }
    return out;
  };
  const next = merge(current, patch as Record<string, unknown>);
  partialConfigSchema.parse(next);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return target;
}

/** Writes a project config. Only pass project-level values: never a config returned by loadConfig() verbatim
 *  if it may contain organization or user settings you don't want committed. */
export function saveConfig(config: GherkinAIConfig, configPath?: string): void {
  const targetPath = configPath || path.join(process.cwd(), 'gherkin-ai.config.json');
  writeFileSync(targetPath, JSON.stringify(config, null, 2));
}
