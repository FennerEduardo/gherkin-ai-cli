/* ==========================================================================
   gherkin-ai-cli - Agent firewall

   One policy decision point for everything an agent may do, whoever the
   agent is (MCP client, autopilot / verify --auto-fix, an IDE hook):

     write <path> · execute <command> · network <host> · secret <name> · tool <mcp tool>
       → ALLOW | REQUIRE_APPROVAL | DENY  (with the rule that decided)

   Sources, merged: built-in deny lists, config `policy.firewall` (org rules
   can be locked by the organization layer), legacy `.ghkgovernance.yaml`,
   and — when a feature is given — the feature's impact scope computed from
   the semantic repository graph: writes outside that scope are denied.
   Every decision is written to the audit trail.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { GherkinAIConfig } from '../config';
import { PolicyError } from '../errors';
import { getTelemetry } from '../telemetry';
import { classifyOperation } from '../../mcp/mcp-operation-safety';
import { buildRepositoryGraph, scopeForFeature } from '../graph/repository-graph';
import { firstMatch } from '../../utils/glob';
import { isPathInside } from '../../utils/path-guard';

export type FirewallActionKind = 'write' | 'execute' | 'network' | 'secret' | 'tool';
export type FirewallVerdict = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

export interface FirewallRequest {
  kind: FirewallActionKind;
  /** Path, command line, host (or URL), secret name or MCP tool name. */
  target: string;
  /** Who asks (mcp, autopilot, verify, hook:claude-code...). Recorded in the audit trail. */
  agent?: string;
}

export interface FirewallDecision {
  verdict: FirewallVerdict;
  kind: FirewallActionKind;
  target: string;
  /** The rule that decided, e.g. "deny-path: .env*". */
  rule: string;
  reason: string;
}

export interface FirewallPolicy {
  workspace: string;
  allowPaths: string[];
  denyPaths: string[];
  approvalPaths: string[];
  allowCommands: string[];
  denyCommands: string[];
  allowHosts: string[];
  allowSecrets: string[];
  /** Impact scope of the feature being implemented (globs), when enforced. */
  scope?: { feature: string; globs: string[] };
}

/** Never writable by an agent, whatever the configuration says. */
export const BUILTIN_DENY_PATHS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '**/secrets/**', '**/*secret*.json', '**/*credentials*',
  '.git/**', '.npmrc', '.pypirc', '**/.aws/**', '**/.ssh/**', '.gherkin-ai/audit/**', '.ghe/logs/**',
  // An agent must not rewrite its own policy.
  '.ghkgovernance.yaml'
];
/** Changes that need a human by default. */
export const BUILTIN_APPROVAL_PATHS = [
  '.github/workflows/**', '.gitlab-ci.yml', 'Jenkinsfile', '**/migrations/**', '**/schema.prisma', 'Dockerfile', '**/docker-compose*.yml',
  '**/infrastructure/**', '**/*.tf', '**/k8s/**', '**/helm/**', 'package.json'
];
/** Commands that are never run on an agent's behalf. Matched as whole words anywhere in the command line. */
export const BUILTIN_DENY_COMMANDS = [
  'sudo', 'su', 'rm -rf /', 'rm -rf ~', 'mkfs', 'dd if=', 'chmod 777', 'git push', 'git reset --hard', 'git clean -fdx', 'npm publish',
  'yarn publish', 'pnpm publish', 'cargo publish', 'gem push', 'twine upload', 'docker push', 'kubectl', 'helm', 'terraform apply',
  'terraform destroy', 'aws ', 'az ', 'gcloud', 'ssh', 'scp', 'curl', 'wget', 'nc ', 'ncat', 'eval', 'base64 -d'
];
/** Read-only and build/test commands that run without approval. */
export const BUILTIN_ALLOW_COMMANDS = [
  'ls', 'cat', 'git status', 'git diff', 'git log', 'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npx jest', 'npx vitest',
  'pytest', 'python -m pytest', 'go test', 'go vet', 'go build', 'mvn test', 'mvn verify', './mvnw', 'gradle test', './gradlew', 'dotnet build',
  'dotnet test', 'cargo build', 'cargo test', 'mix test', 'bundle exec rspec', 'vendor/bin/phpunit', 'php artisan test', 'flutter test',
  'flutter analyze', 'ghk ', 'gherkin-ai '
];
/** Environment variables that hold secrets: reading them needs an explicit allowSecrets entry. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)/i;

function readLegacyGovernance(workspace: string): { allowPaths?: string[]; denyPaths?: string[]; approvalPaths?: string[] } {
  const file = path.join(workspace, '.ghkgovernance.yaml');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
    return { allowPaths: raw.allowedPaths, denyPaths: raw.protectedPaths, approvalPaths: raw.requireHumanApprovalOn };
  } catch {
    return {};
  }
}

export interface FirewallLoadOptions {
  /** Feature being implemented: writes are limited to its impact scope. */
  feature?: string;
}

/** Builds the effective policy for a workspace from config, .ghkgovernance.yaml and the feature scope. */
export function loadFirewallPolicy(workspace: string, config: Partial<GherkinAIConfig>, options: FirewallLoadOptions = {}): FirewallPolicy {
  const fw = config.policy?.firewall ?? {};
  const legacy = readLegacyGovernance(workspace);
  const testCommand = config.testCommand ? [config.testCommand] : [];
  const policy: FirewallPolicy = {
    workspace: path.resolve(workspace),
    allowPaths: [...(fw.allowPaths ?? legacy.allowPaths ?? [])],
    denyPaths: [...BUILTIN_DENY_PATHS, ...(legacy.denyPaths ?? []), ...(fw.denyPaths ?? [])],
    approvalPaths: [...BUILTIN_APPROVAL_PATHS, ...(legacy.approvalPaths ?? []), ...(fw.approvalPaths ?? [])],
    allowCommands: [...BUILTIN_ALLOW_COMMANDS, ...testCommand, ...(fw.allowCommands ?? [])],
    denyCommands: [...BUILTIN_DENY_COMMANDS, ...(fw.denyCommands ?? [])],
    allowHosts: [...(fw.allowHosts ?? [])],
    allowSecrets: [...(fw.allowSecrets ?? [])]
  };
  if (options.feature && fw.enforceFeatureScope !== false) {
    const graph = buildRepositoryGraph(workspace, { specDir: config.specDir });
    const feature = path.relative(workspace, path.resolve(workspace, options.feature)).replace(/\\/g, '/');
    const scope = scopeForFeature(graph, feature);
    // New code for the feature usually lands next to existing tests/specs: keep the spec and test trees writable.
    policy.scope = { feature, globs: [...new Set([...scope.globs, `${path.posix.dirname(feature)}/**`, '**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'])] };
  }
  return policy;
}

const startsWithCommand = (command: string, prefix: string) => {
  const p = prefix.trim();
  return command === p || command.startsWith(`${p} `);
};

function hostOf(target: string): string {
  try {
    return new URL(target.includes('://') ? target : `https://${target}`).hostname.toLowerCase();
  } catch {
    return target.toLowerCase();
  }
}

export class AgentFirewall {
  constructor(readonly policy: FirewallPolicy) {}

  static forWorkspace(workspace: string, config: Partial<GherkinAIConfig>, options: FirewallLoadOptions = {}): AgentFirewall {
    return new AgentFirewall(loadFirewallPolicy(workspace, config, options));
  }

  evaluate(request: FirewallRequest): FirewallDecision {
    const decide = (verdict: FirewallVerdict, rule: string, reason: string): FirewallDecision => ({ verdict, kind: request.kind, target: request.target, rule, reason });
    const p = this.policy;
    switch (request.kind) {
      case 'write': {
        const abs = path.resolve(p.workspace, request.target);
        if (!isPathInside(p.workspace, abs)) return decide('DENY', 'workspace', `${request.target} is outside the workspace.`);
        const rel = path.relative(p.workspace, abs).replace(/\\/g, '/');
        const denied = firstMatch(rel, p.denyPaths);
        if (denied) return decide('DENY', `deny-path: ${denied}`, `${rel} is protected.`);
        if (p.scope && !firstMatch(rel, p.scope.globs)) {
          return decide('DENY', `feature-scope: ${p.scope.feature}`, `${rel} is outside the impact scope of ${p.scope.feature} (see \`ghk graph --scope ${p.scope.feature}\`).`);
        }
        if (p.allowPaths.length > 0 && !firstMatch(rel, p.allowPaths)) return decide('DENY', 'allow-paths', `${rel} is not in the allowed paths.`);
        if (rel === 'gherkin-ai.config.json' && fs.existsSync(abs)) {
          return decide('REQUIRE_APPROVAL', 'policy-file', 'gherkin-ai.config.json holds the agent policy; changing it needs human approval.');
        }
        const approval = firstMatch(rel, p.approvalPaths);
        if (approval) return decide('REQUIRE_APPROVAL', `approval-path: ${approval}`, `Changes to ${rel} need human approval.`);
        return decide('ALLOW', 'default', `${rel} may be written.`);
      }
      case 'execute': {
        const command = request.target.trim().replace(/\s+/g, ' ');
        const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
        for (const pattern of p.denyCommands) {
          const re = new RegExp(`(^|[\\s;&|(\`$])${pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s;&|)])`, 'i');
          if (re.test(command)) return decide('DENY', `deny-command: ${pattern.trim()}`, `"${pattern.trim()}" is not allowed for agents.`);
        }
        const unknown = segments.filter(segment => !p.allowCommands.some(prefix => startsWithCommand(segment, prefix)));
        if (unknown.length > 0) return decide('REQUIRE_APPROVAL', 'allow-commands', `Not in the allowed commands: ${unknown.join(' ; ')}`);
        return decide('ALLOW', 'allow-commands', 'Allowed command.');
      }
      case 'network': {
        const host = hostOf(request.target);
        const allowed = p.allowHosts.find(h => h.toLowerCase() === host || (h.startsWith('*.') && host.endsWith(h.slice(1).toLowerCase())));
        return allowed ? decide('ALLOW', `allow-host: ${allowed}`, `${host} is allowed.`) : decide('DENY', 'allow-hosts', `${host} is not in policy.firewall.allowHosts.`);
      }
      case 'secret': {
        if (p.allowSecrets.includes(request.target)) return decide('ALLOW', `allow-secret: ${request.target}`, 'Explicitly allowed.');
        return SECRET_NAME.test(request.target) || /^\.env/.test(request.target)
          ? decide('DENY', 'secrets', `${request.target} looks like a secret; add it to policy.firewall.allowSecrets to permit it.`)
          : decide('ALLOW', 'default', `${request.target} is not a secret.`);
      }
      case 'tool': {
        const level = classifyOperation(request.target).level;
        if (level === 'destructive') return decide('REQUIRE_APPROVAL', 'mcp-destructive', `${request.target} runs commands or changes code autonomously.`);
        return decide('ALLOW', `mcp-${level}`, `${request.target} is classified ${level}.`);
      }
    }
  }

  /** Evaluates, records the decision in the audit trail and returns it. */
  check(request: FirewallRequest): FirewallDecision {
    const decision = this.evaluate(request);
    getTelemetry().recordAudit({
      source: request.agent === 'mcp' ? 'mcp' : 'cli',
      action: `firewall:${request.kind}`,
      resource: request.target,
      status: decision.verdict === 'ALLOW' ? 'SUCCESS' : 'BLOCKED',
      details: `${decision.verdict} (${decision.rule})${request.agent ? ` agent=${request.agent}` : ''}`
    });
    return decision;
  }

  /** Throws PolicyError unless the action is allowed (or approval was granted by the caller). */
  assert(request: FirewallRequest, options: { approved?: boolean } = {}): FirewallDecision {
    const decision = this.check(request);
    if (decision.verdict === 'DENY' || (decision.verdict === 'REQUIRE_APPROVAL' && !options.approved)) {
      throw new PolicyError(`Agent firewall: ${decision.verdict} ${request.kind} ${request.target} — ${decision.reason}`, {
        hint: decision.verdict === 'REQUIRE_APPROVAL' ? 'A human must approve this action (re-run interactively or adjust policy.firewall).' : `Rule: ${decision.rule}. See docs/ENTERPRISE.md#agent-firewall.`,
        details: decision
      });
    }
    return decision;
  }
}
