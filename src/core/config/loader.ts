/* ==========================================================================
   gherkin-ai-cli - Layered configuration loader

   Precedence (lowest → highest):
     defaults → organization → user → project → environment

   - organization: $GHK_ORG_CONFIG, else /etc/gherkin-ai/config.json
                   (Windows: %ProgramData%\gherkin-ai\config.json)
   - user:         $GHK_USER_CONFIG, else ~/.gherkin-ai/config.json
   - project:      -c <path>, else ./gherkin-ai.config.json
   - environment:  LLM_* / GHK_* / provider-specific variables

   The organization layer may declare `locked: ["llm.allowedProviders", ...]`;
   lower-precedence layers cannot change those paths.
   ========================================================================== */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ZodError } from 'zod';
import { ConfigError } from '../errors';
import { configSchema, partialConfigSchema, GherkinAIConfig, PartialGherkinAIConfig } from './schema';

export type ConfigLayerName = 'defaults' | 'organization' | 'user' | 'project' | 'environment';

export interface ConfigLayer {
  name: ConfigLayerName;
  path?: string;
  values: PartialGherkinAIConfig;
}

export interface ResolvedConfig {
  config: GherkinAIConfig;
  layers: ConfigLayer[];
  /** dot-path → layer that provided the effective value */
  sources: Record<string, ConfigLayerName>;
  /** Non-fatal issues (locked overrides ignored, unknown keys, ...). */
  warnings: string[];
  projectConfigPath: string;
  projectConfigFound: boolean;
}

export interface LoadOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip org/user/env layers (used by commands that edit the project file in place). */
  projectOnly?: boolean;
  /** Fail with ConfigError when the project config file does not exist (e.g. explicit `-c <path>`). */
  requireProject?: boolean;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function orgConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GHK_ORG_CONFIG) return env.GHK_ORG_CONFIG;
  if (process.platform === 'win32') {
    return path.join(env.ProgramData || 'C:\\ProgramData', 'gherkin-ai', 'config.json');
  }
  return '/etc/gherkin-ai/config.json';
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GHK_USER_CONFIG || path.join(os.homedir(), '.gherkin-ai', 'config.json');
}

function formatZodError(err: ZodError, source: string): ConfigError {
  const issues = err.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  return new ConfigError(`Invalid configuration in ${source}:\n${issues.join('\n')}`, {
    hint: 'Run `ghk config validate` for details, or check the JSON Schema in schemas/config.schema.json.',
    details: err.issues
  });
}

function readLayerFile(filePath: string, name: ConfigLayerName, warnings: string[]): ConfigLayer | null {
  if (!fs.existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse ${name} config at ${filePath}: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(`The ${name} config at ${filePath} must be a JSON object.`);
  }

  const known = new Set(Object.keys(partialConfigSchema.shape));
  for (const key of Object.keys(raw)) {
    if (!known.has(key) && key !== '$schema') {
      warnings.push(`Unknown key "${key}" in ${name} config (${filePath}) was ignored.`);
    }
  }

  const result = partialConfigSchema.safeParse(raw);
  if (!result.success) throw formatZodError(result.error, `${name} config (${filePath})`);
  return { name, path: filePath, values: result.data };
}

function envLayer(env: NodeJS.ProcessEnv): ConfigLayer {
  const llm: PlainObject = {};
  const provider = env.GHK_LLM_PROVIDER || env.LLM_PROVIDER;
  if (provider) llm.provider = provider;
  if (env.LLM_MODEL) llm.model = env.LLM_MODEL;
  if (env.LLM_BASE_URL) llm.baseUrl = env.LLM_BASE_URL;
  if (env.GHK_LLM_TIMEOUT_MS) llm.timeoutMs = Number(env.GHK_LLM_TIMEOUT_MS);

  const azure: PlainObject = {};
  if (env.AZURE_OPENAI_ENDPOINT) azure.endpoint = env.AZURE_OPENAI_ENDPOINT;
  if (env.AZURE_OPENAI_DEPLOYMENT) azure.deployment = env.AZURE_OPENAI_DEPLOYMENT;
  if (env.OPENAI_API_VERSION) azure.apiVersion = env.OPENAI_API_VERSION;
  if (Object.keys(azure).length) llm.azure = azure;

  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (region) llm.bedrock = { region };

  const vertex: PlainObject = {};
  if (env.GOOGLE_CLOUD_PROJECT) vertex.project = env.GOOGLE_CLOUD_PROJECT;
  if (env.GOOGLE_CLOUD_LOCATION) vertex.location = env.GOOGLE_CLOUD_LOCATION;
  if (Object.keys(vertex).length) llm.vertex = vertex;

  const values: PlainObject = {};
  if (Object.keys(llm).length) values.llm = llm;
  if (env.GHK_SPEC_DIR) values.specDir = env.GHK_SPEC_DIR;
  if (env.GHK_TELEMETRY_DISABLED === 'true' || env.GHK_TELEMETRY_DISABLED === '1') values.telemetry = { enabled: false };
  if (env.GHK_AUDIT_ENABLED === 'false') values.audit = { enabled: false };
  if (env.GHK_LOG_LEVEL) values.logging = { level: env.GHK_LOG_LEVEL };
  if (env.GHK_LOG_FILE) values.logging = { ...(values.logging as PlainObject), file: env.GHK_LOG_FILE };

  const result = partialConfigSchema.safeParse(values);
  if (!result.success) throw formatZodError(result.error, 'environment variables');
  return { name: 'environment', values: result.data };
}

function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => (isPlainObject(acc) ? acc[key] : undefined), obj);
}

function hasPath(obj: unknown, dotPath: string): boolean {
  const keys = dotPath.split('.');
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isPlainObject(cur) || !(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}

function setPath(obj: PlainObject, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.');
  let cur: PlainObject = obj;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key] as PlainObject;
  }
  cur[keys[keys.length - 1]] = value;
}

/** Deep merge where plain objects merge recursively and arrays/scalars replace. */
function mergeInto(target: PlainObject, source: PlainObject, layer: ConfigLayerName, sources: Record<string, ConfigLayerName>, prefix = ''): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      mergeInto(target[key] as PlainObject, value, layer, sources, dotPath);
    } else {
      target[key] = Array.isArray(value) ? [...value] : value;
      sources[dotPath] = layer;
    }
  }
}

export function resolveConfig(defaults: GherkinAIConfig, options: LoadOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];
  const layers: ConfigLayer[] = [{ name: 'defaults', values: defaults }];

  if (!options.projectOnly) {
    const org = readLayerFile(orgConfigPath(env), 'organization', warnings);
    if (org) layers.push(org);
    const user = readLayerFile(userConfigPath(env), 'user', warnings);
    if (user) layers.push(user);
  }

  const projectConfigPath = options.configPath ? path.resolve(cwd, options.configPath) : path.join(cwd, 'gherkin-ai.config.json');
  if (options.requireProject && !fs.existsSync(projectConfigPath)) {
    throw new ConfigError(`Config file not found: ${projectConfigPath}`, { hint: 'Run `ghk init` to create one, or fix the -c/--config path.' });
  }
  const project = readLayerFile(projectConfigPath, 'project', warnings);
  if (project) layers.push(project);

  if (!options.projectOnly) layers.push(envLayer(env));

  const merged: PlainObject = {};
  const sources: Record<string, ConfigLayerName> = {};
  const orgLayer = layers.find(l => l.name === 'organization');
  const lockedPaths = orgLayer?.values.locked ?? [];
  const lockedValues = new Map<string, unknown>();

  for (const layer of layers) {
    if (layer.name !== 'organization' && layer.name !== 'defaults') {
      for (const locked of lockedPaths) {
        if (hasPath(layer.values, locked) && JSON.stringify(getPath(layer.values, locked)) !== JSON.stringify(lockedValues.get(locked))) {
          warnings.push(`"${locked}" is locked by the organization config; the value from the ${layer.name} layer was ignored.`);
        }
      }
    }
    // `locked` itself is only meaningful in the organization layer.
    const { locked: _ignored, ...values } = layer.values as PartialGherkinAIConfig;
    mergeInto(merged, values as PlainObject, layer.name, sources);
    if (layer.name === 'organization') {
      for (const locked of lockedPaths) lockedValues.set(locked, structuredClone(getPath(merged, locked)));
    }
  }

  for (const [locked, value] of lockedValues) {
    if (value === undefined) continue;
    setPath(merged, locked, structuredClone(value));
    for (const key of Object.keys(sources)) {
      if (key === locked || key.startsWith(`${locked}.`)) sources[key] = 'organization';
    }
  }
  if (lockedPaths.length) merged.locked = [...lockedPaths];

  const result = configSchema.safeParse(merged);
  if (!result.success) throw formatZodError(result.error, 'merged configuration');

  return {
    config: result.data,
    layers,
    sources,
    warnings,
    projectConfigPath,
    projectConfigFound: Boolean(project)
  };
}
