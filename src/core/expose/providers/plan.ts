/* Plan helpers shared by every gateway provider (PLAN-3.3.0-reverse-plus EX-06). */

import type { ControlSupport, ExposeControl, GatewayPlan, GatewayProvider, ProviderManifestView } from '../provider-types';

export const CONTROLS: ExposeControl[] = ['inbound-auth', 'per-tool-authz', 'tenant-isolation', 'outbound-credentials', 'rate-limit', 'human-approval', 'audit', 'private-network', 'tool-discovery'];

export const CONTROL_LABELS: Record<ExposeControl, string> = {
  'inbound-auth': 'caller authentication (OAuth/JWT)',
  'per-tool-authz': 'authorization per tool and caller',
  'tenant-isolation': 'tenant from the identity',
  'outbound-credentials': 'backend credentials kept from the agent',
  'rate-limit': 'rate limits',
  'human-approval': 'a person approves critical calls',
  audit: 'audit trail per call',
  'private-network': 'private network to the backend',
  'tool-discovery': 'semantic search over the tools'
};

/** The plan items every provider shares: each control of each tool where the provider says it is enforced. */
export function planTools(view: ProviderManifestView, capabilities: Record<ExposeControl, ControlSupport>): GatewayPlan['tools'] {
  return view.capabilities.filter(c => c.status === 'approved').map(c => ({
    tool: c.name,
    effect: c.effect,
    scopes: c.authorization.scopes,
    approval: c.execution.approval,
    controls: Object.fromEntries(CONTROLS.map(k => [k, capabilities[k]])) as Record<ExposeControl, ControlSupport>
  }));
}

/** Controls a plan claims `native` that the provider's capabilities() does not: a provider must never do that. */
export function overclaimed(provider: GatewayProvider, plan: GatewayPlan): string[] {
  const caps = provider.capabilities();
  return plan.tools.flatMap(t => Object.entries(t.controls).filter(([k, v]) => v === 'native' && caps[k as ExposeControl] !== 'native').map(([k]) => `${t.tool}: ${k}`));
}
