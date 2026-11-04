/* ==========================================================================
   gherkin-ai-cli - `ghk expose discover` (PLAN-3.3.0-reverse-plus EX-02)

   Proposes the capability manifest from what the project already states:
   - the features' IR: each domain command is a tool that writes;
   - the service contract (OpenAPI): the operation that runs it (the
     handler), its input and output schemas; GET operations of a feature's
     aggregate are tools that read;
   - the tags (@readonly, @pii, @approval, @role:x, @scope:x, @rate:n/min,
     @effect:x) and the industry profile (banking: every write is
     financial-critical);
   - optionally the evidence of `ghk reverse` (--from-reverse).

   It never approves and never grants a write: every capability is
   `proposed`, or `pending-specification` when no feature or no contract
   operation backs it (such a capability is never exposed). It writes only
   inside .ghe/expose/. Deterministic: no clock, no LLM, stable order.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { buildIRFromFile, getSourceFeature } from '../ir-builder';
import type { FieldSpec, SpecificationIR } from '../semantic-ir';
import { detectPromptInjection, redactSensitive } from '../security';
import { featureFilesOrNone } from '../workspace-projects';
import { projectConfig } from '../plugins/load';
import { aggregateTagName, featurePascalName, toCamel, toKebab, toSnake } from '../../utils/naming';
import {
  EXPOSE_DIR, HUMAN_APPROVAL_EFFECTS, MANIFEST_API_VERSION, MANIFEST_FILE, MANIFEST_KIND, PROPOSAL_FILE, TOOL_NAME,
  capabilityFingerprint, isWrite, parseManifest, serializeManifest, EFFECTS, ordinal,
  type Capability, type CapabilityEffect, type CapabilityHandler, type CapabilityManifest
} from './manifest';

type Doc = Record<string, any>;

export interface ContractOperation {
  method: CapabilityHandler['method'];
  path: string;
  operationId?: string;
  summary?: string;
  parameters: { name: string; in: string; required: boolean; schema: Doc; description?: string }[];
  body?: Doc;
  output?: Doc;
}

export interface DiscoverOptions {
  /** OpenAPI file (JSON or YAML), relative to the project; default: <outputDir>/openapi.json, openapi.{json,yaml}, contracts/openapi.{json,yaml}. */
  contract?: string;
  /** Add the endpoints `ghk reverse` found that no feature covers (as pending-specification). */
  fromReverse?: boolean;
  /** Write the proposal (default true; false for --dry-run). */
  write?: boolean;
}

export interface DiscoverChange {
  id: string;
  change: 'new' | 'unchanged' | 'changed' | 'removed';
}

export interface DiscoverResult {
  manifest: CapabilityManifest;
  contract?: string;
  features: number;
  /** Relative path of the written proposal. */
  proposal?: string;
  counts: Record<'proposed' | 'approved' | 'pending-specification', number>;
  /** Against the approved manifest, when there is one. */
  changes: DiscoverChange[];
  warnings: string[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const INFRA_PATH = /^\/(?:health|ready|live|metrics|actuator|openapi|swagger|docs)(?:\/|$)/i;
const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'destroy', 'purge', 'revoke', 'terminate', 'cancel', 'close', 'void', 'erase', 'wipe', 'drop', 'unlink', 'deactivate', 'disable']);
const FINANCIAL_WORDS = /\b(pay|payment|payments|transfer|refund|charge|withdraw|withdrawal|deposit|settle|settlement|disburse|disbursement|capture|payout|loan|credit|debit|invoice|remit|remittance|wire)\b/i;
const FINANCIAL_INDUSTRIES = new Set(['banking', 'insurance']);
const TAG = (key: string) => new RegExp(`^@?${key}[:=(]([^)\\s]+)\\)?$`, 'i');

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

function readDoc(file: string): Doc {
  const text = fs.readFileSync(file, 'utf8');
  return /\.json$/i.test(file) ? JSON.parse(text) : YAML.parse(text);
}

/** Inlines local `$ref`s (`#/components/...`); a cycle stops at the reference. */
export function inlineRefs(value: unknown, doc: Doc, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map(v => inlineRefs(v, doc, seen));
  if (!value || typeof value !== 'object') return value;
  const ref = (value as Doc).$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.includes(ref) || seen.length > 12) return { type: 'object' };
    const target = ref.slice(2).split('/').reduce<any>((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return target === undefined ? { type: 'object' } : inlineRefs(target, doc, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(value as Doc).map(([k, v]) => [k, inlineRefs(v, doc, seen)]));
}

/** JSON Schema of an OpenAPI 3.0 schema: `nullable` becomes a type union, OpenAPI-only keys are dropped. */
function toJsonSchema(schema: Doc | undefined): Doc | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const out: Doc = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['nullable', 'example', 'xml', 'externalDocs', 'discriminator', 'readOnly', 'writeOnly', 'deprecated'].includes(k) || k.startsWith('x-')) continue;
    if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s as Doc)]));
    else if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') out[k] = toJsonSchema(v as Doc);
    else if (['allOf', 'anyOf', 'oneOf'].includes(k) && Array.isArray(v)) out[k] = v.map(s => toJsonSchema(s));
    else out[k] = v;
  }
  if (schema.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

export function contractOperations(doc: Doc): ContractOperation[] {
  const ops: ContractOperation[] = [];
  for (const [p, item] of Object.entries<Doc>(doc.paths ?? {})) {
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(x => inlineRefs(x, doc));
      const body = inlineRefs(op.requestBody?.content?.['application/json']?.schema, doc);
      const status = Object.keys(op.responses ?? {}).filter(code => /^2\d\d$/.test(code)).sort();
      const output = status.map(code => inlineRefs(op.responses[code]?.content?.['application/json']?.schema, doc)).find(Boolean);
      ops.push({
        method: m.toUpperCase() as ContractOperation['method'],
        path: p,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        parameters: params.filter(x => x && typeof x.name === 'string').map(x => ({ name: x.name, in: x.in, required: x.required === true || x.in === 'path', schema: x.schema ?? { type: 'string' }, description: x.description })),
        body: toJsonSchema(body),
        output: toJsonSchema(output)
      });
    }
  }
  return ops.sort((a, b) => ordinal(a.path, b.path) || ordinal(a.method, b.method));
}

function findContract(root: string, explicit?: string): string | undefined {
  if (explicit) {
    const file = path.resolve(root, explicit);
    if (!fs.existsSync(file)) throw new Error(`Contract not found: ${explicit}`);
    return file;
  }
  const outputDir = projectConfig(root)?.outputDir;
  const candidates = [
    ...(outputDir ? [path.join(outputDir, 'openapi.json'), path.join(outputDir, 'openapi.yaml')] : []),
    'openapi.json', 'openapi.yaml', 'openapi.yml', 'contracts/openapi.json', 'contracts/openapi.yaml'
  ];
  return candidates.map(c => path.resolve(root, c)).find(f => fs.existsSync(f));
}

/** The service contract's operations: `explicit`, else the manifest's `service.contract`, else the default places. */
export function loadContract(root: string, explicit?: string): { file?: string; operations: ContractOperation[] } {
  const file = findContract(root, explicit);
  return { file: file ? rel(root, file) : undefined, operations: file ? contractOperations(readDoc(file)) : [] };
}

// ---------------------------------------------------------------------------
// From the features
// ---------------------------------------------------------------------------

function allTags(ir: SpecificationIR, scenarioIds?: Set<string>): string[] {
  const scenarios = ir.scenarios.filter(sc => !scenarioIds || scenarioIds.has(sc.id));
  return [...new Set([...ir.tags, ...scenarios.flatMap(sc => sc.tags)])];
}

const tagValues = (tags: string[], key: string) => tags.map(t => TAG(key).exec(t.trim())?.[1]).filter((v): v is string => Boolean(v));
const hasTag = (tags: string[], name: string) => tags.some(t => t.trim().toLowerCase() === `@${name}`);

function fieldSchema(f: FieldSpec): Doc {
  const type = f.type === 'date' ? 'string' : f.type === 'enum' ? 'string' : f.type === 'unknown' ? 'string' : f.type;
  const s: Doc = { type };
  if (f.type === 'date') s.format = 'date';
  if (f.enumValues?.length) s.enum = [...f.enumValues];
  for (const v of f.validations) {
    if (v.type === 'email') s.format = 'email';
    if (v.type === 'uuid') s.format = 'uuid';
    if (v.type === 'min' && typeof v.params?.value === 'number') s.minimum = v.params.value;
    if (v.type === 'max' && typeof v.params?.value === 'number') s.maximum = v.params.value;
    if (v.type === 'minLength' && typeof v.params?.value === 'number') s.minLength = v.params.value;
    if (v.type === 'maxLength' && typeof v.params?.value === 'number') s.maxLength = v.params.value;
  }
  if (type === 'string' && s.maxLength === undefined && !s.enum && !s.format) s.maxLength = 1024;
  return s;
}

/** A sentence is kept only when it carries no secret, personal data or instruction to the model. */
function safeText(text: string): string | undefined {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  if (!detectPromptInjection(clean).isSafe) return undefined;
  if (redactSensitive(clean, { pii: true }) !== clean) return undefined;
  return clean;
}

function effectOf(verb: string, subject: string, tags: string[], industry?: string): CapabilityEffect {
  const explicit = tagValues(tags, 'effect').find(v => (EFFECTS as readonly string[]).includes(v));
  if (explicit) return explicit as CapabilityEffect;
  if (hasTag(tags, 'readonly')) return 'read';
  if (hasTag(tags, 'financial') || (industry && FINANCIAL_INDUSTRIES.has(industry)) || FINANCIAL_WORDS.test(`${verb} ${subject}`.replace(/_/g, ' '))) return 'financial-critical';
  if (DESTRUCTIVE_VERBS.has(verb.toLowerCase())) return 'destructive';
  return 'write';
}

function rateOf(tags: string[]): number | undefined {
  for (const v of tagValues(tags, 'rate')) {
    const m = /^(\d+)\/(min|m|minute|h|hour|s|sec)$/i.exec(v);
    if (!m) continue;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return Math.max(1, unit.startsWith('h') ? Math.floor(n / 60) : unit.startsWith('s') ? n * 60 : n);
  }
  return undefined;
}

const titleOf = (tool: string) => {
  const t = tool.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function describe(ir: SpecificationIR, scenarioNames: string[], effect: CapabilityEffect, approval: 'none' | 'human', extra?: string): string {
  const parts: string[] = [];
  const name = safeText(ir.featureName);
  if (name) parts.push(`${name.replace(/[.\s]+$/, '')}.`);
  const story = (ir.featureDescription.map(safeText).filter(Boolean) as string[]).map((l, i) => { const t = l.replace(/[.,;]+$/, ''); return i && /^(So that|In order to)\b/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t; }).join(', ');
  if (story) parts.push(story.endsWith('.') ? story : `${story}.`);
  if (extra) parts.push(extra);
  const cases = scenarioNames.map(safeText).filter(Boolean) as string[];
  if (cases.length) parts.push(`Specified behaviour: ${cases.slice(0, 8).join('; ')}.`);
  const rules = ir.constraints.map(c => c.description).filter(d => !/^Industry Requirement/.test(d)).map(safeText).filter(Boolean) as string[];
  if (rules.length) parts.push(`Rules: ${rules.slice(0, 3).join('; ')}.`);
  if (isWrite(effect)) parts.push(`Effect: ${effect}; it changes state${approval === 'human' ? ' and needs a person to approve each call' : ''}.`);
  else parts.push('Effect: read only.');
  return parts.join(' ').slice(0, 1800);
}

/**
 * Input fields of a command: its own (when the IR names them), else the DataTable columns of the
 * When steps of its scenarios, with the IR's type and validations and the first data row as example.
 */
function commandFields(ir: SpecificationIR, commandFields: FieldSpec[], scenarioNames: Set<string>): FieldSpec[] {
  if (commandFields.length) return commandFields;
  const parsed = getSourceFeature(ir);
  const byName = new Map<string, FieldSpec>();
  for (const sc of parsed?.scenarios ?? []) {
    if (!scenarioNames.has(sc.name)) continue;
    let primary = '';
    for (const st of sc.steps) {
      if (st.keyword !== 'And' && st.keyword !== 'But') primary = st.keyword;
      if (primary !== 'When') continue;
      const rows = st.text.split('\n').filter(l => l.trim().startsWith('|')).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
      if (rows.length < 1) continue;
      const vertical = rows[0].length === 2 && /^(field|campo|name|nombre|attribute|atributo|property|propiedad)$/i.test(rows[0][0]);
      const pairs: [string, string | undefined][] = vertical ? rows.slice(1).map(r => [r[0], r[1]]) : rows[0].map((h, i) => [h, rows[1]?.[i]]);
      for (const [header, example] of pairs) {
        const name = header.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!name || byName.has(name)) continue;
        const known = ir.fields.find(f => f.name === name);
        const type = known?.type && known.type !== 'string' ? known.type : example !== undefined && example !== '' && !Number.isNaN(Number(example)) ? 'number' : 'string';
        byName.set(name, { name, type, required: true, validations: known?.validations ?? [], exampleValues: example ? [example] : [], ...(known?.enumValues ? { enumValues: known.enumValues } : {}) });
      }
    }
  }
  return [...byName.values()];
}

interface FeatureInfo {
  file: string;
  ir: SpecificationIR;
  aggregate: string;
}

function commandHandler(command: string, ops: ContractOperation[]): { op: ContractOperation; fixed?: string } | undefined {
  const snake = toSnake(command);
  for (const op of ops) {
    if (op.method === 'GET') continue;
    const param = op.parameters.find(x => x.in === 'path' && Array.isArray(x.schema?.enum) && x.schema.enum.includes(snake));
    if (param) return { op, fixed: param.name };
  }
  const camel = toCamel(command).toLowerCase();
  const op = ops.find(o => o.method !== 'GET' && o.operationId && o.operationId.toLowerCase() === camel);
  return op ? { op } : undefined;
}

function argName(param: string): string {
  return param.toLowerCase() === 'idempotency-key' ? 'idempotency_key' : toSnake(param);
}

/** Handler and input schema of an operation; `fixed` is the path parameter set to the command's name. */
function shape(op: ContractOperation, command: string | undefined, fixedParam: string | undefined, fields: FieldSpec[], write: boolean) {
  const properties: Doc = {};
  const required: string[] = [];
  const parameters: CapabilityHandler['parameters'] = [];
  for (const p of op.parameters) {
    if (p.in === 'header' && p.name.toLowerCase() !== 'idempotency-key') continue; // traceparent and the rest are set by the runtime
    if (p.in === 'cookie') continue;
    if (p.name === fixedParam && command) {
      parameters.push({ name: p.name, in: 'path', value: toSnake(command) });
      continue;
    }
    const arg = argName(p.name);
    parameters.push({ name: p.name, in: p.in as 'path' | 'query' | 'header', argument: arg });
    if (arg === 'idempotency_key') continue;
    properties[arg] = { ...(toJsonSchema(p.schema) ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(arg);
  }
  const bodyProps: Doc = { ...(op.body?.properties ?? {}) };
  for (const f of fields) {
    const name = toSnake(f.name);
    if (!bodyProps[name] && !properties[name]) bodyProps[name] = fieldSchema(f);
  }
  for (const [name, schema] of Object.entries(bodyProps)) {
    if (properties[name]) continue;
    properties[name] = schema;
    if ((op.body?.required ?? []).includes(name) || fields.some(f => toSnake(f.name) === name && f.required)) required.push(name);
  }
  if (write) {
    properties.idempotency_key = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'Unique per intended operation: a retry with the same key never runs it twice.' };
    required.push('idempotency_key');
    if (!parameters.some(p => p.argument === 'idempotency_key')) parameters.push({ name: 'Idempotency-Key', in: 'header', argument: 'idempotency_key' });
  }
  const input: Doc = { type: 'object', additionalProperties: false, properties, required: [...new Set(required)].sort() };
  const handler: CapabilityHandler = { method: op.method, path: op.path, ...(op.operationId ? { operationId: op.operationId } : {}), parameters, body: Object.keys(bodyProps).length > 0 || op.body !== undefined && op.method !== 'GET' };
  return { input, handler };
}

function examplesOf(fields: FieldSpec[], input: Doc): Capability['examples'] {
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    const value = f.exampleValues.find(v => safeText(v) && redactSensitive(v, { pii: true }) === v); // no personal data in a committed manifest
    if (value === undefined) continue;
    args[toSnake(f.name)] = f.type === 'number' && !Number.isNaN(Number(value)) ? Number(value) : f.type === 'boolean' ? value === 'true' : value;
  }
  if (!Object.keys(args).length) return [];
  for (const key of (input.required as string[]) ?? []) if (!(key in args)) args[key] = `<${key}>`;
  return [{ name: 'from the scenarios', arguments: Object.fromEntries(Object.keys(args).sort().map(k => [k, args[k]])) }];
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export function readApprovedManifest(root: string): CapabilityManifest | undefined {
  const file = path.join(root, MANIFEST_FILE);
  return fs.existsSync(file) ? parseManifest(fs.readFileSync(file, 'utf8'), MANIFEST_FILE) : undefined;
}

export function writeExposeFile(root: string, relative: string, content: string): string {
  const dir = path.join(root, EXPOSE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  }
  const target = path.join(dir, relative);
  if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) throw new Error(`Refusing to write outside ${EXPOSE_DIR}: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function uniqueName(name: string, aggregate: string, used: Set<string>): string {
  let candidate = name.slice(0, 64);
  if (used.has(candidate)) candidate = `${toSnake(aggregate)}_${name}`.slice(0, 64);
  let n = 2;
  while (used.has(candidate)) candidate = `${name.slice(0, 60)}_${n++}`;
  used.add(candidate);
  return candidate;
}

export function discoverCapabilities(root: string, options: DiscoverOptions = {}): DiscoverResult {
  const config = projectConfig(root);
  const industry = config?.industry?.id ?? undefined;
  const tenantClaim = config?.security?.tenantClaim ?? 'tenant_id';
  const warnings: string[] = [];
  const contractFile = findContract(root, options.contract);
  const ops = contractFile ? contractOperations(readDoc(contractFile)) : [];
  if (!contractFile) warnings.push('No OpenAPI contract found (generated-specs/openapi.json, openapi.json or --contract): every capability stays pending-specification until one exists.');

  const features: FeatureInfo[] = featureFilesOrNone(root).sort().map(file => {
    const ir = buildIRFromFile(file, rel(root, file), { mode: 'deterministic', industry });
    return { file: rel(root, file), ir, aggregate: aggregateTagName(ir.tags) ?? featurePascalName(ir) };
  });

  const capabilities: Capability[] = [];
  const usedOps = new Set<ContractOperation>();
  const usedNames = new Set<string>();
  const tenancy = { source: 'identity' as const, claim: tenantClaim };

  for (const { file, ir, aggregate } of features) {
    const agg = toKebab(aggregate);
    for (const command of ir.commands) {
      const scenarioIds = new Set(ir.scenarios.filter(sc => sc.commands.includes(command.id)).map(sc => sc.id));
      const scenarios = ir.scenarios.filter(sc => scenarioIds.has(sc.id));
      const tags = allTags(ir, scenarioIds.size ? scenarioIds : undefined);
      const effect = effectOf(command.verb, command.subject, tags, industry);
      const approval: 'none' | 'human' = (HUMAN_APPROVAL_EFFECTS as readonly string[]).includes(effect) || hasTag(tags, 'approval') ? 'human' : 'none';
      const write = isWrite(effect);
      const tool = uniqueName(toSnake(command.name), aggregate, usedNames);
      const match = commandHandler(command.name, ops);
      if (match) usedOps.add(match.op);
      const fields = commandFields(ir, command.inputFields, new Set(scenarios.map(sc => sc.name)));
      const { input, handler } = match ? shape(match.op, command.name, match.fixed, fields, write) : { input: { type: 'object', additionalProperties: false, properties: {}, required: [] } as Doc, handler: undefined };
      capabilities.push({
        id: `${agg}.${tool}`,
        name: tool,
        version: 1,
        title: titleOf(tool),
        description: describe(ir, scenarios.map(sc => sc.name), effect, approval),
        effect,
        status: handler ? 'proposed' : 'pending-specification',
        ...(handler ? {} : { reason: `No operation of the contract runs ${command.name}${contractFile ? ` (${rel(root, contractFile)})` : ''}.` }),
        source: { features: [file], scenarios: scenarios.map(sc => sc.name).sort(), evidence: [] },
        ...(handler ? { handler } : {}),
        input,
        ...(match?.op.output ? { output: match.op.output } : {}),
        examples: examplesOf(fields, input),
        authorization: {
          scopes: tagValues(tags, 'scope').length ? [...new Set(tagValues(tags, 'scope'))].sort() : [`${agg}:${write ? 'write' : 'read'}`],
          roles: [...new Set(tagValues(tags, 'role'))].sort()
        },
        tenancy,
        execution: { approval, idempotency: write ? 'required' : 'none', timeoutMs: 10_000, ...(rateOf(tags) ? { rateLimitPerMinute: rateOf(tags) } : {}) },
        pii: hasTag(tags, 'pii'),
        tags: tags.filter(t => /^@(readonly|pii|approval|financial|role|scope|rate|effect)\b/i.test(t.trim())).sort()
      });
    }
  }

  // Reads: GET operations of a feature's aggregate. Other operations are pending: no feature specifies them.
  for (const op of ops) {
    if (usedOps.has(op) || INFRA_PATH.test(op.path.replace(/^\/api(?:\/v\d+)?/, ''))) continue;
    const owner = features.find(f => op.path.toLowerCase().split('/').includes(toKebab(f.aggregate)));
    const read = op.method === 'GET';
    const tags = owner ? allTags(owner.ir) : [];
    const effect: CapabilityEffect = read ? 'read' : effectOf(op.method === 'DELETE' ? 'delete' : op.method.toLowerCase(), op.path, tags, industry);
    const base = op.operationId ? toSnake(op.operationId) : toSnake(`${op.method.toLowerCase()} ${op.path.replace(/[{}]/g, '')}`);
    const tool = uniqueName(base, owner?.aggregate ?? 'api', usedNames);
    const proposed = Boolean(owner && read);
    const { input, handler } = shape(op, undefined, undefined, [], isWrite(effect));
    const approval: 'none' | 'human' = (HUMAN_APPROVAL_EFFECTS as readonly string[]).includes(effect) ? 'human' : 'none';
    capabilities.push({
      id: `${owner ? toKebab(owner.aggregate) : 'api'}.${tool}`,
      name: tool,
      version: 1,
      title: titleOf(tool),
      description: owner
        ? describe(owner.ir, [], effect, approval, safeText(op.summary ?? '') ? `${safeText(op.summary ?? '')!.replace(/\.$/, '')}.` : undefined)
        : `${safeText(op.summary ?? '') ?? `${op.method} ${op.path}`}. No feature specifies this operation.`,
      effect,
      status: proposed ? 'proposed' : 'pending-specification',
      ...(proposed ? {} : { reason: owner ? 'A write that no domain command of the feature names: specify it as a command first.' : 'No feature specifies this operation: write one (or `ghk reverse accept`) before exposing it.' }),
      source: { features: owner ? [owner.file] : [], scenarios: [], evidence: [] },
      handler,
      input,
      ...(op.output ? { output: op.output } : {}),
      examples: [],
      authorization: { scopes: [`${owner ? toKebab(owner.aggregate) : 'api'}:${read ? 'read' : 'write'}`], roles: [] },
      tenancy,
      execution: { approval, idempotency: isWrite(effect) ? 'required' : 'none', timeoutMs: 10_000 },
      pii: owner ? hasTag(tags, 'pii') : false,
      tags: []
    });
  }

  if (options.fromReverse) addReverseCandidates(root, capabilities, usedNames, tenancy, warnings);

  const approved = readApprovedManifest(root);
  const changes: DiscoverChange[] = [];
  for (const c of capabilities) {
    const before = approved?.capabilities.find(a => a.id === c.id);
    if (!approved) continue;
    if (!before) {
      changes.push({ id: c.id, change: 'new' });
      continue;
    }
    const same = before.approval?.fingerprint === capabilityFingerprint(c);
    changes.push({ id: c.id, change: same ? 'unchanged' : 'changed' });
    if (same && before.status === 'approved' && c.status === 'proposed') Object.assign(c, { status: 'approved', approval: before.approval });
  }
  for (const a of approved?.capabilities ?? []) if (!capabilities.some(c => c.id === a.id)) changes.push({ id: a.id, change: 'removed' });

  const manifest: CapabilityManifest = {
    apiVersion: MANIFEST_API_VERSION,
    kind: MANIFEST_KIND,
    service: {
      name: config?.projectName ?? path.basename(root),
      ...(contractFile ? { contract: rel(root, contractFile) } : {}),
      ...(industry ? { industry } : {}),
      baseUrlEnv: approved?.service.baseUrlEnv ?? 'GHK_UPSTREAM_URL'
    },
    identity: approved?.identity ?? { tenantClaim, scopesClaim: 'scope', rolesClaim: 'roles' },
    environments: approved?.environments ?? [],
    capabilities
  };
  // Validates what was built (a bug here must fail loudly, never write an invalid proposal).
  const text = serializeManifest(manifest, 'Proposed by `ghk expose discover`. Nothing here is approved: review it, then `ghk expose approve <id>`.');
  const parsed = parseManifest(text, PROPOSAL_FILE);
  let proposal: string | undefined;
  if (options.write !== false) proposal = rel(root, writeExposeFile(root, PROPOSAL_FILE, text));
  const counts = { proposed: 0, approved: 0, 'pending-specification': 0 };
  for (const c of parsed.capabilities) counts[c.status]++;
  return { manifest: parsed, contract: contractFile ? rel(root, contractFile) : undefined, features: features.length, proposal, counts, changes: changes.sort((a, b) => ordinal(a.id, b.id)), warnings };
}

/** Endpoints found by `ghk reverse` and not run by any capability: pending until a feature specifies them. */
function addReverseCandidates(root: string, capabilities: Capability[], used: Set<string>, tenancy: Capability['tenancy'], warnings: string[]): void {
  const file = path.join(root, '.ghe/reverse/candidates.json');
  if (!fs.existsSync(file)) {
    warnings.push('--from-reverse: no .ghe/reverse/candidates.json; run `ghk reverse propose` first.');
    return;
  }
  let candidates: { aggregate: string; operation: { type: string; name: string; method: string; path: string }; endpointEvidence: string[] }[] = [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    candidates = Array.isArray(data) ? data : data.candidates ?? [];
  } catch {
    warnings.push('--from-reverse: .ghe/reverse/candidates.json is not valid JSON; run `ghk reverse propose` again.');
    return;
  }
  const norm = (p: string) => p.replace(/\{[^}]+\}|:[A-Za-z_]+/g, '{}').replace(/\/+$/, '').toLowerCase();
  for (const c of [...candidates].sort((a, b) => ordinal(a.operation.name, b.operation.name))) {
    const method = c.operation.method?.toUpperCase();
    if (!method || !c.operation.path) continue;
    if (capabilities.some(x => x.handler && x.handler.method === method && norm(x.handler.path) === norm(c.operation.path))) continue;
    const tool = uniqueName(toSnake(c.operation.name), c.aggregate, used);
    if (!TOOL_NAME.test(tool)) continue;
    capabilities.push({
      id: `${toKebab(c.aggregate)}.${tool}`,
      name: tool,
      version: 1,
      title: titleOf(tool),
      description: `${method} ${c.operation.path}, found in the code by ghk reverse. No feature specifies it.`,
      effect: method === 'GET' ? 'read' : method === 'DELETE' ? 'destructive' : 'write',
      status: 'pending-specification',
      reason: 'Found by `ghk reverse` only: accept a feature for it (`ghk reverse accept`) before exposing it.',
      source: { features: [], scenarios: [], evidence: [...c.endpointEvidence].sort() },
      input: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      examples: [],
      authorization: { scopes: [], roles: [] },
      tenancy,
      execution: { approval: method === 'DELETE' ? 'human' : 'none', idempotency: method === 'GET' ? 'none' : 'required', timeoutMs: 10_000 },
      pii: false,
      tags: []
    });
  }
}
