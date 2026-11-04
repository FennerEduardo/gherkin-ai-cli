/* ==========================================================================
   gherkin-ai-cli - Loading a project's plugins outside `generate`
   (PLAN-3.3.0-reverse-plus EC-01)

   `reverse scan`, `lint` and `expose` work without `ghk init`, so they load
   the plugins themselves: the effective configuration of the project
   (organization → user → project layers, so `plugins.allow` and the locks
   of the organization apply), then `plugins.load`. A plugin that is not
   allowed, fails its integrity check or is incompatible stops the command
   with the error of the plugin system (exit 5 for policy).
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { loadConfig, type GherkinAIConfig } from '../config';
import { pluginRegistry, type PluginRegistry } from '../plugin-system';

/** The project's effective configuration, or undefined when it has none and no layer adds plugins. */
export function projectConfig(root: string): GherkinAIConfig | undefined {
  const file = path.join(root, 'gherkin-ai.config.json');
  try {
    return loadConfig(fs.existsSync(file) ? file : undefined);
  } catch {
    return undefined; // an invalid configuration is reported by ghk validate
  }
}

/** Loads `plugins.load` of the project into the shared registry, once per process; returns the registry. */
export function loadProjectPlugins(root: string): PluginRegistry {
  const config = projectConfig(root);
  if (config?.plugins?.load?.length) pluginRegistry.loadFromConfig(config, root);
  return pluginRegistry;
}
