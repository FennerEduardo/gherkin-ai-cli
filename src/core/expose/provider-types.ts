/* ==========================================================================
   gherkin-ai-cli - Gateway providers for `ghk expose`
   (PLAN-3.3.0-reverse-plus EX-06), the contract plugins implement (EC-01)

   A provider turns the approved capability manifest into the artifacts its
   cloud needs (infrastructure as code, gateway configuration). It never
   applies them: `ghk expose publish` runs the provider's tool after the
   user confirms. Each security control is declared honestly:
   - native: the gateway enforces it;
   - runtime: gherkin-ai's generated MCP runtime enforces it (it always
     authorizes again, whatever the gateway does);
   - unsupported: nobody enforces it on this provider, and `expose plan`
     says so. A provider never claims a control it does not provide.
   ========================================================================== */

export type ExposeControl =
  | 'inbound-auth'        // OAuth/JWT or IAM on the way in
  | 'per-tool-authz'      // a policy per tool and caller
  | 'tenant-isolation'    // the tenant comes from the identity
  | 'outbound-credentials'// the backend's credentials, never seen by the agent
  | 'rate-limit'
  | 'human-approval'      // approval: human on writes
  | 'audit'
  | 'private-network'
  | 'tool-discovery';     // semantic search over the tools

export type ControlSupport = 'native' | 'runtime' | 'unsupported';

export interface GeneratedFile {
  /** Path relative to the output directory (expose/<target>/…). */
  path: string;
  content: string;
}

export interface GatewayPlanItem {
  tool: string;
  effect: string;
  scopes: string[];
  approval: 'none' | 'human';
  /** Where each control of this tool is enforced. */
  controls: Partial<Record<ExposeControl, ControlSupport>>;
}

export interface GatewayPlan {
  provider: string;
  tools: GatewayPlanItem[];
  /** Resources the IaC creates, for the person who approves the plan (no cost is invented). */
  resources: string[];
  /** What the provider cannot guarantee, said in plain words. */
  warnings: string[];
}

/** The parts of the capability manifest a provider reads (see src/core/expose/manifest.ts). */
export interface ProviderManifestView {
  service: string;
  capabilities: { id: string; name: string; description: string; effect: string; status: string; authorization: { scopes: string[]; roles: string[] }; execution: { approval: 'none' | 'human' } }[];
}

export interface GatewayProviderOptions {
  environment: string;
  /** Container image of the generated MCP runtime, when the provider hosts it. */
  image?: string;
  /** Existing OIDC discovery URL for inbound JWTs; when absent a provider may create its own identity pool. */
  discoveryUrl?: string;
  /** Accepted JWT audiences or client ids. */
  audiences?: string[];
  region?: string;
}

export interface GatewayProvider {
  /** `aws-agentcore`, `azure-apim`, `gcp-apigateway`, … */
  id: string;
  label: string;
  /** core: maintained with gherkin-ai; community: from a plugin. */
  tier: 'core' | 'community';
  maturity: 'beta' | 'experimental';
  capabilities(): Record<ExposeControl, ControlSupport>;
  plan(manifest: ProviderManifestView, options: GatewayProviderOptions): GatewayPlan;
  emit(manifest: ProviderManifestView, options: GatewayProviderOptions): GeneratedFile[];
  /** The command that validates the emitted files offline (`terraform validate`, `bicep build`), for `ghk plugin verify` and the goldens. */
  validateCommand?: string[];
}
