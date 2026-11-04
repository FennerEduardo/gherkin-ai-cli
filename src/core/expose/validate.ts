/* ==========================================================================
   gherkin-ai-cli - `ghk expose validate` (PLAN-3.3.0-reverse-plus EX-09)

   Checks an approved manifest before anything is generated from it:
   - the schema;
   - every exposed write is approved, for named environments, and the
     approval still matches what it covers (exit 5, a policy);
   - effects agree with tags and handlers; destructive and
     financial-critical need a person per call; writes need an
     idempotency key (exit 5);
   - no description carries a secret, personal data or an instruction to
     the model: tool poisoning (exit 4);
   - every handler still exists in the contract (exit 4);
   - against the previous manifest, an incompatible change of a tool's
     input or output bumps its version (exit 4).
   ========================================================================== */

import { containsSecret, detectPromptInjection, redactSensitive } from '../security';
import type { ContractOperation } from './discover';
import { HUMAN_APPROVAL_EFFECTS, capabilityFingerprint, isWrite, type Capability, type CapabilityManifest } from './manifest';
import { PRODUCTION_ENVIRONMENTS } from './approve';

export interface ExposeIssue {
  code: string;
  severity: 'error' | 'warning';
  /** 5: a policy (writes without approval); 4: a quality gate. */
  exit: 4 | 5;
  capability?: string;
  message: string;
}

export interface ValidateOptions {
  /** The manifest of the base branch (git HEAD by default), for incompatible changes. */
  previous?: CapabilityManifest;
  /** The operations of the service contract, to check that each handler still exists. */
  contract?: ContractOperation[];
}

type Doc = Record<string, any>;

const hasTag = (c: Capability, name: string) => c.tags.some(t => t.trim().toLowerCase() === `@${name}`);

/** Every human-readable string of a capability an agent will read. */
function textsOf(c: Capability): { where: string; text: string }[] {
  const out = [{ where: 'title', text: c.title }, { where: 'description', text: c.description }];
  const walk = (schema: unknown, where: string) => {
    if (!schema || typeof schema !== 'object') return;
    const s = schema as Doc;
    if (typeof s.description === 'string') out.push({ where: `${where}.description`, text: s.description });
    if (typeof s.title === 'string') out.push({ where: `${where}.title`, text: s.title });
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${where}.${k}`);
    if (s.items) walk(s.items, `${where}[]`);
  };
  walk(c.input, 'input');
  walk(c.output, 'output');
  return out;
}

const typeOf = (s: Doc | undefined) => JSON.stringify(s?.type ?? null);

/** Why a change of `before` into `after` breaks a caller (input: what it may send; output: what it reads). */
export function incompatibleChanges(before: Doc | undefined, after: Doc | undefined, side: 'input' | 'output', where: string = side): string[] {
  if (!before || !after) return before && !after && side === 'output' ? [`${where}: removed`] : [];
  const out: string[] = [];
  if (typeOf(before) !== typeOf(after) && before.type !== undefined) out.push(`${where}: type ${typeOf(before)} → ${typeOf(after)}`);
  if (Array.isArray(before.enum) && side === 'input') {
    const lost = before.enum.filter((v: unknown) => !(after.enum ?? []).includes(v));
    if (Array.isArray(after.enum) && lost.length) out.push(`${where}: no longer accepts ${lost.join(', ')}`);
  }
  if (Array.isArray(after.enum) && side === 'output') {
    const added = after.enum.filter((v: unknown) => !(before.enum ?? []).includes(v));
    if (Array.isArray(before.enum) && added.length) out.push(`${where}: may now return ${added.join(', ')}`);
  }
  const bp: Doc = before.properties ?? {};
  const ap: Doc = after.properties ?? {};
  for (const name of Object.keys(bp)) {
    if (!(name in ap)) {
      if (side === 'output' || before.additionalProperties !== true) out.push(`${where}.${name}: removed`);
      continue;
    }
    out.push(...incompatibleChanges(bp[name], ap[name], side, `${where}.${name}`));
  }
  if (side === 'input') {
    const req = new Set<string>(before.required ?? []);
    for (const name of after.required ?? []) if (!req.has(name)) out.push(`${where}.${name}: now required`);
  } else {
    const req = new Set<string>(after.required ?? []);
    for (const name of before.required ?? []) if (!req.has(name) && name in ap) out.push(`${where}.${name}: no longer always present`);
  }
  return out;
}

const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}').toLowerCase();

export function validateManifest(manifest: CapabilityManifest, options: ValidateOptions = {}): ExposeIssue[] {
  const issues: ExposeIssue[] = [];
  const add = (code: string, exit: 4 | 5, capability: string | undefined, message: string, severity: 'error' | 'warning' = 'error') =>
    issues.push({ code, severity, exit, ...(capability ? { capability } : {}), message });
  const envs = new Map(manifest.environments.map(e => [e.name, e]));

  for (const c of manifest.capabilities) {
    const write = isWrite(c.effect);
    // --- approval (exit 5) ---
    if (c.status !== 'approved') {
      add('EXV001', 5, c.id, `Status is ${c.status}: the approved manifest holds approved capabilities only; it is not exposed.`, 'warning');
      continue;
    }
    if (!c.approval) add('EXV010', 5, c.id, 'Approved without an approval record (who, when, environments): approve it with `ghk expose approve`.');
    else if (c.approval.fingerprint !== capabilityFingerprint(c)) add('EXV011', 5, c.id, 'Changed since it was approved (handler, input, effect, authorization or limits): approve it again.');
    if (!c.handler) add('EXV012', 5, c.id, 'Approved without a handler: nothing runs it.');
    if (!c.source.features.length) add('EXV013', 5, c.id, 'No feature specifies it: only capabilities with a feature are exposed (D-6).');
    if (write && c.approval && !c.approval.environments.length) add('EXV014', 5, c.id, `A ${c.effect} capability approved for no environment.`);
    for (const env of c.approval?.environments ?? []) {
      if (write && PRODUCTION_ENVIRONMENTS.test(env) && !envs.get(env)?.allowWrites) add('EXV015', 5, c.id, `Writes in ${env} without an explicit policy (environments: { name: ${env}, allowWrites: true }).`);
    }
    if ((HUMAN_APPROVAL_EFFECTS as readonly string[]).includes(c.effect) && c.execution.approval !== 'human') add('EXV016', 5, c.id, `${c.effect} without a person approving each call (execution.approval: human).`);
    if (write && c.execution.idempotency !== 'required') add('EXV017', 5, c.id, 'A write without a required idempotency key: a retry could run it twice.');
    if (write && !(c.input.required as string[] | undefined)?.includes('idempotency_key')) add('EXV017', 5, c.id, 'A write whose input does not require idempotency_key.');
    if (hasTag(c, 'approval') && c.execution.approval !== 'human') add('EXV016', 5, c.id, 'Tagged @approval without execution.approval: human.');
    if (!(c.authorization.scopes.length || c.authorization.roles.length)) add('EXV018', 5, c.id, 'No scope or role authorizes it: every tool is authorized per caller.');

    // --- coherence (exit 4) ---
    if (hasTag(c, 'readonly') && write) add('EXV020', 4, c.id, `Tagged @readonly but its effect is ${c.effect}.`);
    if (c.handler?.method === 'GET' && write) add('EXV021', 4, c.id, `A GET handler with the effect ${c.effect}.`, 'warning');
    if (c.handler && c.handler.method !== 'GET' && !write && c.effect === 'read') add('EXV022', 4, c.id, `${c.handler.method} handler with the effect read: a method that changes state is not a read.`);
    if (c.handler?.method === 'DELETE' && !['destructive', 'financial-critical'].includes(c.effect)) add('EXV023', 4, c.id, `A DELETE handler with the effect ${c.effect}: classify it destructive.`);
    if (hasTag(c, 'pii') && !c.pii) add('EXV024', 4, c.id, 'Tagged @pii but pii is false: the runtime would not redact its responses.');
    if (c.input.additionalProperties !== false) add('EXV025', 4, c.id, 'The input accepts properties it does not declare (additionalProperties must be false).');

    // --- tool poisoning (exit 4) ---
    for (const { where, text } of textsOf(c)) {
      const secret = containsSecret(text);
      if (secret) add('EXV030', 4, c.id, `${where} carries what looks like a secret (${secret.name}).`);
      else if (!detectPromptInjection(text, { checkSecrets: false }).isSafe) add('EXV031', 4, c.id, `${where} carries an instruction to the model (tool poisoning).`);
      else if (redactSensitive(text, { pii: true }) !== text) add('EXV032', 4, c.id, `${where} carries personal data.`);
    }
    for (const ex of c.examples) {
      const text = JSON.stringify(ex.arguments);
      if (containsSecret(text) || redactSensitive(text, { pii: true }) !== text) add('EXV033', 4, c.id, `Example "${ex.name}" carries a secret or personal data.`);
    }

    // --- contract (exit 4) ---
    if (options.contract && c.handler) {
      const op = options.contract.find(o => o.method === c.handler!.method && norm(o.path) === norm(c.handler!.path));
      if (!op) add('EXV040', 4, c.id, `${c.handler.method} ${c.handler.path} is not in the contract any more.`);
      else {
        const fixed = c.handler.parameters.filter(p => p.value !== undefined);
        for (const p of fixed) {
          const param = op.parameters.find(x => x.name === p.name);
          if (Array.isArray(param?.schema?.enum) && !param!.schema.enum.includes(p.value)) add('EXV041', 4, c.id, `The contract's ${p.name} no longer accepts ${p.value}.`);
        }
      }
    }

    // --- incompatible changes against the previous manifest (exit 4) ---
    const before = options.previous?.capabilities.find(p => p.id === c.id);
    if (before) {
      const breaks = [...incompatibleChanges(before.input, c.input, 'input'), ...incompatibleChanges(before.output, c.output, 'output')];
      if (breaks.length && c.version <= before.version) add('EXV050', 4, c.id, `Incompatible change without a new version (${before.version}): ${breaks.join('; ')}. Bump version and tell the agents' owners.`);
      if (c.name !== before.name) add('EXV051', 4, c.id, `Tool renamed ${before.name} → ${c.name}: agents calling the old name break.`, 'warning');
    }
  }
  for (const p of options.previous?.capabilities ?? []) {
    if (!manifest.capabilities.some(c => c.id === p.id)) add('EXV052', 4, p.id, `Removed: agents calling ${p.name} break.`, 'warning');
  }
  return issues.sort((a, b) => (a.capability ?? '').localeCompare(b.capability ?? '') || a.code.localeCompare(b.code));
}

/** 5 when a policy is broken, 4 when a quality gate fails, 0 otherwise (warnings never fail). */
export function validationExitCode(issues: ExposeIssue[]): 0 | 4 | 5 {
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.some(i => i.exit === 5)) return 5;
  return errors.length ? 4 : 0;
}
