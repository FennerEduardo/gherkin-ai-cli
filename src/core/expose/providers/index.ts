/* ==========================================================================
   gherkin-ai-cli - Gateway providers of `ghk expose` (PLAN-3.3.0-reverse-plus EX-06)

   Core providers (maintained with gherkin-ai) and the ones plugins add
   (`gatewayProviders()`, plugin API 2). A provider reads only the approved
   manifest, through ProviderManifestView, and declares where each control
   is enforced: native (its gateway), runtime (the generated MCP runtime) or
   unsupported. `plan` shows it per tool; nothing claims what it does not do.
   ========================================================================== */

import { loadProjectPlugins } from '../../plugins/load';
import type { CapabilityManifest } from '../manifest';
import type { GatewayProvider, ProviderManifestView } from '../provider-types';
import { awsAgentCoreProvider } from './aws-agentcore';
import { containerProvider } from './container';

export { CONTROLS, CONTROL_LABELS, planTools, overclaimed } from './plan';

export function coreProviders(): GatewayProvider[] {
  return [containerProvider, awsAgentCoreProvider];
}

/** Core providers, then the project's plugin providers (a plugin cannot replace a core id). */
export function availableProviders(root: string): (GatewayProvider & { plugin?: string })[] {
  const core = coreProviders();
  const plugins = loadProjectPlugins(root).getGatewayProviders().filter(p => !core.some(c => c.id === p.id));
  return [...core, ...plugins];
}

export function findProvider(root: string, id: string): (GatewayProvider & { plugin?: string }) | undefined {
  return availableProviders(root).find(p => p.id === id);
}

/** What a provider sees: the approved capabilities only. */
export function providerView(manifest: CapabilityManifest): ProviderManifestView {
  return {
    service: manifest.service.name,
    ...(manifest.service.industry ? { industry: manifest.service.industry } : {}),
    identity: manifest.identity,
    baseUrlEnv: manifest.service.baseUrlEnv,
    capabilities: manifest.capabilities.filter(c => c.status === 'approved' && c.approval && c.handler).map(c => ({
      id: c.id,
      name: c.name,
      title: c.title,
      version: c.version,
      description: c.description,
      effect: c.effect,
      status: c.status,
      authorization: c.authorization,
      execution: c.execution,
      input: c.input,
      handler: { method: c.handler!.method, path: c.handler!.path },
      environments: c.approval!.environments
    }))
  };
}
