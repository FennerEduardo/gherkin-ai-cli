/* ==========================================================================
   gherkin-ai-cli - One write policy for every entry point (M-01)

   The agent firewall decides every write. Before 3.2.1 three more engines
   (guardrails in verify/autopilot, AgentPolicyEngine in the MCP governance
   tool, write-protection) matched paths with their own regexes, so one let
   through what another blocked. Now guardrails and AgentPolicyEngine ask the
   firewall, and this module adds what only an automated repair loop needs:

   - file classes: secret | spec | contract | test | migration | infra | source
   - during `verify --auto-fix` / `autopilot` repair, the agent fixes the
     implementation: specifications, contracts and tests are what it is
     measured against, so changing them needs a human.
   ========================================================================== */

import path from 'path';
import type { AgentFirewall, FirewallDecision } from './agent-firewall';

export type FileClass = 'secret' | 'spec' | 'contract' | 'test' | 'migration' | 'infra' | 'source';

const CLASSES: [FileClass, RegExp][] = [
  ['secret', /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519).*|.*secret.*\.json|.*credentials.*)$|(^|\/)secrets\//i],
  ['spec', /\.feature$/i],
  ['contract', /(^|\/)contracts\/|(^|\/)(openapi|asyncapi|swagger)\.(json|ya?ml)$|\.(proto|graphql)$/i],
  ['test', /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec|steps?)\.\w+$|(Test|Tests|IT|Spec|Steps)\.\w+$|(^|\/)test_[^/]*\.py$|_test\.(go|exs?)$/],
  ['migration', /(^|\/)(migrations?|db\/migrate|flyway)\/|schema\.prisma$/i],
  ['infra', /(^|\/)(infrastructure|infra|deploy|k8s|helm|terraform)\/|\.(tf|tfvars|tfbackend)$|(^|\/)Dockerfile$|docker-compose[^/]*\.ya?ml$|(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$/i]
];

export function classifyFile(file: string): FileClass {
  const p = file.replace(/\\/g, '/');
  return CLASSES.find(([, re]) => re.test(p))?.[0] ?? 'source';
}

/** Classes an automated repair loop may not change without a human. */
export const REPAIR_PROTECTED_CLASSES: FileClass[] = ['spec', 'contract', 'test'];

export interface WriteVerdict extends Pick<FirewallDecision, 'verdict' | 'rule' | 'reason'> {
  file: string;
  fileClass: FileClass;
}

/**
 * The verdict for an agent writing `file`: the firewall's, and in `repair` mode a REQUIRE_APPROVAL for
 * specifications, contracts and tests (the loop must make the implementation meet them, not move them).
 */
export function writeVerdict(firewall: AgentFirewall, file: string, mode: 'agent' | 'repair' = 'agent'): WriteVerdict {
  const rel = path.isAbsolute(file) ? path.relative(firewall.policy.workspace, file).replace(/\\/g, '/') : file.replace(/\\/g, '/');
  const fileClass = classifyFile(rel);
  const decision = firewall.evaluate({ kind: 'write', target: file });
  if (decision.verdict === 'ALLOW' && mode === 'repair' && REPAIR_PROTECTED_CLASSES.includes(fileClass)) {
    return { file: rel, fileClass, verdict: 'REQUIRE_APPROVAL', rule: `repair-protected: ${fileClass}`, reason: `${rel} is a ${fileClass}: the repair loop changes the implementation, not what it is checked against.` };
  }
  return { file: rel, fileClass, verdict: decision.verdict, rule: decision.rule, reason: decision.reason };
}
