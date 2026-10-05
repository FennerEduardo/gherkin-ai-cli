/* ==========================================================================
   gherkin-ai-cli - `ghk config` (show | validate | schema)
   ========================================================================== */

import { emitData, emitJson } from '../utils/output';
import { loadResolvedConfig, ResolvedConfig } from '../core/config';
import { buildConfigJsonSchema } from '../core/config/json-schema';
import { UsageError } from '../core/errors';
import { logger } from '../utils/logger';

export interface ConfigCommandOptions {
  config?: string;
  json?: boolean;
  sources?: boolean;
}

function layerSummary(resolved: ResolvedConfig) {
  return resolved.layers.map(l => ({ name: l.name, path: l.path }));
}

export async function handleConfigCommand(subcommand: string | undefined, options: ConfigCommandOptions = {}): Promise<unknown> {
  const action = subcommand || 'show';

  if (action === 'schema') {
    const schema = buildConfigJsonSchema();
    emitJson(schema);
    return schema;
  }

  if (action !== 'show' && action !== 'validate') {
    throw new UsageError(`Unknown config subcommand "${action}".`, { hint: 'Use one of: show, validate, schema.' });
  }

  // Throws ConfigError (exit code 3) on any invalid layer.
  const resolved = loadResolvedConfig({ configPath: options.config, requireProject: Boolean(options.config) });

  if (action === 'validate') {
    const result = {
      valid: true,
      projectConfig: resolved.projectConfigFound ? resolved.projectConfigPath : null,
      layers: layerSummary(resolved),
      warnings: resolved.warnings
    };
    if (options.json) {
      emitJson(result);
    } else {
      logger.success('✔ Configuration is valid.');
      for (const layer of result.layers) logger.info(`   ${layer.name.padEnd(13)} ${layer.path ?? ''}`);
      for (const warning of resolved.warnings) logger.warn(`⚠️  ${warning}`);
      if (!resolved.projectConfigFound) logger.warn('⚠️  No project gherkin-ai.config.json found; using defaults. Run `ghk init` to create one.');
    }
    return result;
  }

  const result = {
    config: resolved.config,
    layers: layerSummary(resolved),
    ...(options.sources ? { sources: resolved.sources } : {}),
    warnings: resolved.warnings
  };
  if (options.json) {
    emitJson(result);
  } else {
    emitData(JSON.stringify(resolved.config, null, 2) + '\n');
    if (options.sources) {
      logger.info('\nValue sources:');
      for (const [key, layer] of Object.entries(resolved.sources).sort()) logger.info(`   ${key.padEnd(36)} ${layer}`);
    }
    for (const warning of resolved.warnings) logger.warn(`⚠️  ${warning}`);
  }
  return result;
}
