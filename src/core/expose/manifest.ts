/* ==========================================================================
   gherkin-ai-cli - Capability manifest of `ghk expose` (PLAN-3.3.0-reverse-plus EX-01)

   The manifest is the one artifact a person reviews before an agent can
   call the service. `ghk expose discover` proposes it (in .ghe/expose/),
   `ghk expose approve` writes the approved capabilities to
   .ghk/capabilities.yaml (committed, reviewed by PR), and every emitter
   (the MCP runtime, the gateway providers) reads only that file.

   A capability is one domain command (a write) or one query (a read). Its
   description comes from the feature's scenarios, not from the contract's
   summary. Nothing in it is a secret: credentials are references.
   ========================================================================== */

import { createHash } from 'crypto';
import { z } from 'zod';
import YAML from 'yaml';

export const MANIFEST_API_VERSION = 'gherkin-ai.dev/v1';
export const MANIFEST_KIND = 'CapabilityManifest';
/** The approved manifest, relative to the project. */
export const MANIFEST_FILE = '.ghk/capabilities.yaml';
/** Where discover writes its proposal (ignored by git). */
export const EXPOSE_DIR = '.ghe/expose';
export const PROPOSAL_FILE = 'capabilities.proposed.yaml';
export const MANIFEST_SCHEMA_ID = 'https://unpkg.com/gherkin-ai/schemas/capabilities.schema.json';

export const EFFECTS = ['read', 'analysis', 'test-execution', 'write', 'destructive', 'financial-critical'] as const;
export type CapabilityEffect = (typeof EFFECTS)[number];
/** Effects that change state: never exposed without an approval, an idempotency key and named environments. */
export const WRITE_EFFECTS: readonly CapabilityEffect[] = ['write', 'destructive', 'financial-critical'];
/** Effects that need a person to approve each call at run time (D-10, D-11). */
export const HUMAN_APPROVAL_EFFECTS: readonly CapabilityEffect[] = ['destructive', 'financial-critical'];

export const STATUSES = ['proposed', 'approved', 'pending-specification'] as const;
export type CapabilityStatus = (typeof STATUSES)[number];

/** MCP tool names: letters, digits, `_` and `-`, at most 64 characters. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const jsonSchema = z.record(z.string(), z.unknown());

const argumentSchema = z.object({
  /** Placeholder in the path (`{id}`) or a header, filled from the tool's arguments. */
  name: z.string().min(1),
  in: z.enum(['path', 'query', 'header']),
  /** The tool argument that carries it; absent when `value` is fixed. */
  argument: z.string().min(1).optional(),
  value: z.string().optional()
}).strict();

export const handlerSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Path template of the contract operation, relative to the service's base URL. */
  path: z.string().regex(/^\/[^\s?#]*$/),
  operationId: z.string().optional(),
  parameters: z.array(argumentSchema).default([]),
  /** The tool arguments sent as the JSON body (every argument that is not a parameter). */
  body: z.boolean().default(false)
}).strict();

export const approvalSchema = z.object({
  by: z.string().min(1),
  /** ISO date (YYYY-MM-DD). */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  environments: z.array(z.string().min(1)).default([]),
  note: z.string().optional(),
  /** Fingerprint of the capability as approved: a later change of handler, input or effect needs a new approval. */
  fingerprint: z.string().regex(/^sha256-[a-f0-9]{16}$/)
}).strict();

export const capabilitySchema = z.object({
  /** Stable id: `<aggregate-kebab>.<tool>`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
  /** MCP tool name. */
  name: z.string().regex(TOOL_NAME),
  /** Bumped when the input or output changes incompatibly (EX-09). */
  version: z.number().int().min(1).default(1),
  title: z.string().min(1),
  description: z.string().min(1),
  effect: z.enum(EFFECTS),
  status: z.enum(STATUSES),
  /** Why a capability is pending, in plain words. */
  reason: z.string().optional(),
  source: z.object({
    features: z.array(z.string()).default([]),
    scenarios: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([])
  }).strict(),
  handler: handlerSchema.optional(),
  input: jsonSchema,
  output: jsonSchema.optional(),
  examples: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict()).default([]),
  authorization: z.object({
    scopes: z.array(z.string().min(1)).default([]),
    roles: z.array(z.string().min(1)).default([])
  }).strict(),
  /** The tenant always comes from the caller's identity, never from the arguments. */
  tenancy: z.object({ source: z.literal('identity'), claim: z.string().min(1) }).strict(),
  execution: z.object({
    approval: z.enum(['none', 'human']),
    idempotency: z.enum(['required', 'none']),
    timeoutMs: z.number().int().min(100).max(120_000),
    rateLimitPerMinute: z.number().int().min(1).optional()
  }).strict(),
  /** `@pii`: the runtime redacts personal data in the response. */
  pii: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  approval: approvalSchema.optional()
}).strict();

export type Capability = z.infer<typeof capabilitySchema>;
export type CapabilityHandler = z.infer<typeof handlerSchema>;
export type CapabilityApproval = z.infer<typeof approvalSchema>;

export const manifestSchema = z.object({
  apiVersion: z.literal(MANIFEST_API_VERSION),
  kind: z.literal(MANIFEST_KIND),
  service: z.object({
    name: z.string().min(1),
    /** The contract the handlers come from, relative to the project. */
    contract: z.string().optional(),
    industry: z.string().optional(),
    /** Environment variable that holds the backend's base URL in the runtime (never a URL with credentials). */
    baseUrlEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('GHK_UPSTREAM_URL')
  }).strict(),
  identity: z.object({
    tenantClaim: z.string().min(1).default('tenant_id'),
    scopesClaim: z.string().min(1).default('scope'),
    rolesClaim: z.string().min(1).default('roles')
  }).strict(),
  /**
   * Environments a write may run in. `prod` needs `allowWrites: true` here and in the
   * capability's approval (EX-03): a write approved for `dev` never reaches production.
   */
  environments: z.array(z.object({ name: z.string().min(1), allowWrites: z.boolean().default(false) }).strict()).default([]),
  capabilities: z.array(capabilitySchema)
}).strict();

export type CapabilityManifest = z.infer<typeof manifestSchema>;

export function isWrite(effect: string): boolean {
  return (WRITE_EFFECTS as readonly string[]).includes(effect);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** What an approval covers: a change of any of these needs a new approval. */
export function capabilityFingerprint(c: Pick<Capability, 'name' | 'effect' | 'handler' | 'input' | 'authorization' | 'execution'>): string {
  const material = JSON.stringify(canonical({ name: c.name, effect: c.effect, handler: c.handler ?? null, input: c.input, authorization: c.authorization, execution: c.execution }));
  return `sha256-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

export class ManifestError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Parses and validates a manifest (YAML or JSON text). */
export function parseManifest(text: string, file = MANIFEST_FILE): CapabilityManifest {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (err) {
    throw new ManifestError(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  const result = manifestSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ManifestError(`${file} does not match the capability manifest schema`, issues);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const issues: string[] = [];
  for (const c of result.data.capabilities) {
    if (ids.has(c.id)) issues.push(`capabilities: duplicate id ${c.id}`);
    if (names.has(c.name)) issues.push(`capabilities: duplicate tool name ${c.name}`);
    ids.add(c.id);
    names.add(c.name);
  }
  if (issues.length) throw new ManifestError(`${file} has duplicate capabilities`, issues);
  return result.data;
}

/** Stable YAML: capabilities by id, keys in schema order (zod's), so two runs give identical bytes. */
export function serializeManifest(manifest: CapabilityManifest, header?: string): string {
  const sorted: CapabilityManifest = { ...manifest, capabilities: [...manifest.capabilities].sort((a, b) => a.id.localeCompare(b.id)) };
  const body = YAML.stringify(manifestSchema.parse(sorted), { lineWidth: 0, aliasDuplicateObjects: false });
  return header ? `${header.split('\n').map(l => `# ${l}`.trimEnd()).join('\n')}\n${body}` : body;
}

/** The JSON Schema published as schemas/capabilities.schema.json. */
export function buildManifestJsonSchema(): Record<string, unknown> {
  const { $schema: _draft, ...schema } = z.toJSONSchema(manifestSchema, { target: 'draft-7', io: 'input', reused: 'inline', unrepresentable: 'any' }) as Record<string, unknown>;
  return { $schema: 'http://json-schema.org/draft-07/schema#', $id: MANIFEST_SCHEMA_ID, title: 'gherkin-ai capability manifest (ghk expose)', ...schema };
}
