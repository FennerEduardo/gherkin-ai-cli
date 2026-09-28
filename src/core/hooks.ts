import { ParsedFeature } from './gherkin-parser';
import { GherkinAIConfig } from './config';

export type HookEvent = 'beforeGenerate' | 'afterGenerate' | 'beforeVerify' | 'afterVerify' | 'onAgentRepair';

type HookCallback = (context: any) => Promise<void> | void;

class PluginManager {
  private hooks: Map<HookEvent, HookCallback[]> = new Map();

  register(event: HookEvent, callback: HookCallback) {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(callback);
  }

  async trigger(event: HookEvent, context: any): Promise<void> {
    const callbacks = this.hooks.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        await cb(context);
      }
    }
  }

  loadPlugins(config: GherkinAIConfig) {
    // Dynamically load plugins from config if they exist
    if ((config as any).plugins && Array.isArray((config as any).plugins)) {
      for (const pluginName of (config as any).plugins) {
        try {
          // Attempt to load local module or from node_modules
          const pluginModule = require(pluginName);
          if (pluginModule && typeof pluginModule.register === 'function') {
            pluginModule.register(this);
          }
        } catch (err) {
          console.warn(`[Hooks] Could not load plugin: ${pluginName}`);
        }
      }
    }
  }
}

export const pluginManager = new PluginManager();
