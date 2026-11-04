/* ==========================================================================
   gherkin-ai-cli - `ghk expose approve` / `revoke` (PLAN-3.3.0-reverse-plus EX-03)

   Approval is per capability and is written to .ghk/capabilities.yaml,
   which holds only approved capabilities, is versioned in git and is
   reviewed by PR. What a person approves is pinned by a fingerprint: a
   later change of handler, input, effect or limits needs a new approval.

   Rules:
   - a pending-specification capability is never approved;
   - the proposal must match the features and contract of today
     (discover again when it does not);
   - a write needs the environments it may run in (--env);
   - a write in a production environment needs that environment declared
     with `allowWrites: true` in the manifest, an explicit, reviewed policy.
   ========================================================================== */

import {
  MANIFEST_API_VERSION, MANIFEST_KIND, capabilityFingerprint, isWrite, ordinal,
  type Capability, type CapabilityManifest
} from './manifest';

export const PRODUCTION_ENVIRONMENTS = /^(prod|production|prd|live)$/i;

export interface ApproveRequest {
  ids: string[];
  all?: boolean;
  environments: string[];
  by: string;
  /** YYYY-MM-DD */
  at: string;
  note?: string;
}

export interface ApprovalRefusal {
  id: string;
  reason: string;
  /** true: a policy refuses it (exit 5); false: the request is wrong (exit 2). */
  policy: boolean;
}

export interface ApprovalPlan {
  manifest: CapabilityManifest;
  approved: string[];
  refused: ApprovalRefusal[];
}

/** The approved manifest after approving `request.ids` of `proposal`, checked against a fresh discover. */
export function planApproval(proposal: CapabilityManifest, fresh: CapabilityManifest, current: CapabilityManifest | undefined, request: ApproveRequest): ApprovalPlan {
  const refused: ApprovalRefusal[] = [];
  const approved: Capability[] = [];
  const environments = [...(current?.environments ?? proposal.environments)];
  const ids = request.all ? proposal.capabilities.filter(c => c.status !== 'pending-specification').map(c => c.id) : request.ids;
  if (!ids.length) refused.push({ id: '(none)', reason: 'Name the capabilities to approve, or pass --all.', policy: false });

  for (const id of ids) {
    const cap = proposal.capabilities.find(c => c.id === id || c.name === id);
    if (!cap) {
      refused.push({ id, reason: 'Not in the proposal (.ghe/expose/capabilities.proposed.yaml).', policy: false });
      continue;
    }
    if (cap.status === 'pending-specification' || !cap.handler) {
      refused.push({ id: cap.id, reason: `Pending specification: ${cap.reason ?? 'no feature or contract operation backs it'}. It is never exposed.`, policy: true });
      continue;
    }
    if (!cap.source.features.length) {
      refused.push({ id: cap.id, reason: 'No feature specifies it: only capabilities with a feature are exposed (D-6).', policy: true });
      continue;
    }
    const now = fresh.capabilities.find(c => c.id === cap.id);
    if (!now || capabilityFingerprint(now) !== capabilityFingerprint(cap)) {
      refused.push({ id: cap.id, reason: 'The proposal no longer matches the features or the contract: run `ghk expose discover` and review it again.', policy: false });
      continue;
    }
    const write = isWrite(cap.effect);
    if (write && !request.environments.length) {
      refused.push({ id: cap.id, reason: `A ${cap.effect} capability needs the environments it may run in: --env dev (repeatable).`, policy: false });
      continue;
    }
    const prodNotAllowed = write
      ? request.environments.filter(e => PRODUCTION_ENVIRONMENTS.test(e) && !environments.some(x => x.name === e && x.allowWrites))
      : [];
    if (prodNotAllowed.length) {
      refused.push({
        id: cap.id,
        reason: `Writes in ${prodNotAllowed.join(', ')} need an explicit policy: declare \`environments: [{ name: ${prodNotAllowed[0]}, allowWrites: true }]\` in .ghk/capabilities.yaml and have it reviewed, then approve again.`,
        policy: true
      });
      continue;
    }
    approved.push({
      ...cap,
      status: 'approved',
      approval: {
        by: request.by,
        at: request.at,
        environments: [...new Set(request.environments)].sort(),
        ...(request.note ? { note: request.note } : {}),
        fingerprint: capabilityFingerprint(cap)
      }
    });
  }

  for (const env of request.environments) {
    if (!environments.some(e => e.name === env)) environments.push({ name: env, allowWrites: !PRODUCTION_ENVIRONMENTS.test(env) });
  }
  const kept = (current?.capabilities ?? []).filter(c => !approved.some(a => a.id === c.id));
  const manifest: CapabilityManifest = {
    apiVersion: MANIFEST_API_VERSION,
    kind: MANIFEST_KIND,
    service: current?.service ?? proposal.service,
    identity: current?.identity ?? proposal.identity,
    environments: environments.sort((a, b) => ordinal(a.name, b.name)),
    capabilities: [...kept, ...approved]
  };
  return { manifest, approved: approved.map(a => a.id).sort(), refused };
}

/** The approved manifest without the revoked capabilities. */
export function planRevoke(current: CapabilityManifest, ids: string[]): { manifest: CapabilityManifest; revoked: string[]; unknown: string[] } {
  const match = (c: Capability, id: string) => c.id === id || c.name === id;
  const revoked = current.capabilities.filter(c => ids.some(id => match(c, id))).map(c => c.id).sort();
  const unknown = ids.filter(id => !current.capabilities.some(c => match(c, id)));
  return { manifest: { ...current, capabilities: current.capabilities.filter(c => !revoked.includes(c.id)) }, revoked, unknown };
}
