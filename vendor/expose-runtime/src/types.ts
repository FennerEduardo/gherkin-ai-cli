/* The approved capabilities this runtime serves (capabilities.json, written by ghk expose generate from
 * .ghk/capabilities.yaml). Only approved capabilities are in it. */

export type Effect = 'read' | 'analysis' | 'test-execution' | 'write' | 'destructive' | 'financial-critical';

export interface HandlerParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  argument?: string;
  value?: string;
}

export interface Capability {
  id: string;
  name: string;
  version: number;
  title: string;
  description: string;
  effect: Effect;
  source: { features: string[]; scenarios: string[] };
  handler: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; parameters: HandlerParameter[]; body: boolean };
  input: Record<string, unknown>;
  authorization: { scopes: string[]; roles: string[] };
  execution: { approval: 'none' | 'human'; idempotency: 'required' | 'none'; timeoutMs: number; rateLimitPerMinute?: number };
  pii: boolean;
  /** Environments the approval names (empty for a read: every environment). */
  environments: string[];
}

export interface RuntimeManifest {
  service: string;
  generatedFrom: string;
  identity: { tenantClaim: string; scopesClaim: string; rolesClaim: string };
  upstreamUrlEnv: string;
  capabilities: Capability[];
}

export interface FeatureDoc {
  id: string;
  name: string;
  description: string[];
  tags: string[];
  rules: string[];
  scenarios: { name: string; tags: string[]; steps: string[] }[];
}

export const WRITE_EFFECTS: Effect[] = ['write', 'destructive', 'financial-critical'];
