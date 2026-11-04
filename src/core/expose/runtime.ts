/* ==========================================================================
   gherkin-ai-cli - The generated MCP runtime (PLAN-3.3.0-reverse-plus EX-04, EX-05)

   `ghk expose generate --target mcp-runtime` writes expose/mcp-runtime/:
   one TypeScript server (Node 24, CommonJS) for any backend stack, since it
   calls the service's HTTP API. Its code is vendor/expose-runtime/ (kept as
   real, type-checked sources); this module adds what is specific to the
   project:
   - config/capabilities.json: the approved capabilities only;
   - config/features.json: the features those capabilities come from (the
     context tools, EX-05), by name, never by repository path;
   - package.json with exact versions, the Dockerfile and a README.
   Deterministic: the same manifest gives the same bytes.
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { parseGherkinText } from '../gherkin-parser';
import { buildIR } from '../ir-builder';
import type { GeneratedFile } from './provider-types';
import { ordinal, type CapabilityManifest } from './manifest';

/** Exact versions of what the generated runtime installs (bumped with gherkin-ai, never ranges). */
export const RUNTIME_VERSIONS = {
  node: '24',
  mcpSdk: '1.32.1',
  typescript: '5.9.3',
  typesNode: '24.19.2'
} as const;

export const RUNTIME_DIR = 'expose/mcp-runtime';

/** vendor/expose-runtime, found upwards from this file (src/… in tests, dist/… when installed). */
export function runtimeTemplateDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'vendor', 'expose-runtime');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('vendor/expose-runtime not found: the gherkin-ai package is incomplete.');
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.feature$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'feature';

/** The runtime's view of the approved capabilities. */
export function runtimeManifest(manifest: CapabilityManifest) {
  return {
    service: manifest.service.name,
    generatedFrom: '.ghk/capabilities.yaml',
    identity: manifest.identity,
    upstreamUrlEnv: manifest.service.baseUrlEnv,
    capabilities: manifest.capabilities
      .filter(c => c.status === 'approved' && c.approval && c.handler)
      .sort((a, b) => ordinal(a.name, b.name))
      .map(c => ({
        id: c.id,
        name: c.name,
        version: c.version,
        title: c.title,
        description: c.description,
        effect: c.effect,
        source: { features: c.source.features.map(f => slug(path.basename(f))), scenarios: c.source.scenarios },
        handler: { method: c.handler!.method, path: c.handler!.path, parameters: c.handler!.parameters, body: c.handler!.body },
        input: c.input,
        authorization: c.authorization,
        execution: c.execution,
        pii: c.pii,
        environments: c.approval!.environments
      }))
  };
}

/** The features behind the approved capabilities, as the context tools serve them. */
export function featureDocs(root: string, manifest: CapabilityManifest) {
  const files = [...new Set(manifest.capabilities.filter(c => c.status === 'approved').flatMap(c => c.source.features))].sort();
  return files.filter(f => fs.existsSync(path.join(root, f))).map(f => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const parsed = parseGherkinText(text);
    const ir = buildIR(parsed, f, { mode: 'deterministic', industry: manifest.service.industry });
    const rules = [...new Set([
      ...(text.match(/^\s*(?:Rule|Regla):\s*(.+)$/gm) ?? []).map(l => l.replace(/^\s*(?:Rule|Regla):\s*/, '').trim()),
      ...ir.invariants.map(i => i.expression),
      ...ir.constraints.filter(c => !/^Industry Requirement/.test(c.description)).map(c => c.description)
    ])];
    return {
      id: slug(path.basename(f)),
      name: parsed.featureName,
      description: parsed.descriptionLines.map(l => l.trim()).filter(Boolean),
      tags: parsed.tags,
      rules,
      scenarios: parsed.scenarios.map(sc => ({ name: sc.name, tags: sc.tags, steps: sc.steps.map(st => `${st.keyword} ${st.text}`) }))
    };
  });
}

export function generateRuntime(root: string, manifest: CapabilityManifest): GeneratedFile[] {
  const template = runtimeTemplateDir();
  const files: GeneratedFile[] = [];
  for (const name of fs.readdirSync(path.join(template, 'src')).sort()) {
    if (name.endsWith('.ts')) files.push({ path: `src/${name}`, content: fs.readFileSync(path.join(template, 'src', name), 'utf8') });
  }
  const runtime = runtimeManifest(manifest);
  const pkgName = `${slug(manifest.service.name)}-mcp-runtime`.slice(0, 214);
  files.push(
    { path: 'tsconfig.json', content: fs.readFileSync(path.join(template, 'tsconfig.json'), 'utf8') },
    { path: 'Dockerfile', content: fs.readFileSync(path.join(template, 'Dockerfile'), 'utf8') },
    { path: '.dockerignore', content: fs.readFileSync(path.join(template, 'dockerignore'), 'utf8') },
    { path: 'config/capabilities.json', content: `${JSON.stringify(runtime, null, 2)}\n` },
    { path: 'config/features.json', content: `${JSON.stringify(featureDocs(root, manifest), null, 2)}\n` },
    {
      path: 'package.json',
      content: `${JSON.stringify({
        name: pkgName,
        version: '1.0.0',
        private: true,
        description: `MCP server of ${manifest.service.name}'s approved business capabilities (generated by gherkin-ai: ghk expose generate)`,
        main: 'dist/server.js',
        engines: { node: `>=${RUNTIME_VERSIONS.node}` },
        scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/server.js' },
        dependencies: { '@modelcontextprotocol/sdk': RUNTIME_VERSIONS.mcpSdk },
        devDependencies: { typescript: RUNTIME_VERSIONS.typescript, '@types/node': RUNTIME_VERSIONS.typesNode }
      }, null, 2)}\n`
    },
    { path: 'README.md', content: readme(manifest, runtime.capabilities.length) }
  );
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // ordinal: the same order in every locale
}

function readme(manifest: CapabilityManifest, tools: number): string {
  return `# ${manifest.service.name} MCP runtime

Generated by gherkin-ai (\`ghk expose generate --target mcp-runtime\`) from \`.ghk/capabilities.yaml\`: ${tools} approved tool(s). Do not edit: change the features or the manifest, approve, and generate again.

It serves the approved capabilities over MCP (Streamable HTTP, stateless) on \`0.0.0.0:8000/mcp\` and calls the service's HTTP API. Every call is authorized here, whatever a gateway in front decided.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| \`GHK_ENVIRONMENT\` | yes | The environment this runtime serves (\`dev\`, \`prod\`, …). A write runs only where its approval names it. |
| \`${manifest.service.baseUrlEnv}\` | yes | Base URL of the service. The only host the runtime calls. https, unless \`GHK_UPSTREAM_ALLOW_HTTP=true\` on a private network. |
| \`GHK_OIDC_ISSUER\` | yes | Issuer of the callers' tokens (https). Its keys come from its discovery document, or \`GHK_OIDC_JWKS_URL\`. |
| \`GHK_OIDC_AUDIENCE\` | yes | Accepted audiences or client ids, comma-separated. |
| \`GHK_UPSTREAM_AUTH\` | no | \`mint-hs256\` (default: a 60-second token for the caller's subject and tenant, signed with \`GHK_UPSTREAM_JWT_SECRET\`, as the generated kernels expect), \`bearer\` (\`GHK_UPSTREAM_TOKEN\`) or \`none\`. |
| \`GHK_UPSTREAM_JWT_SECRET\`, \`GHK_UPSTREAM_TOKEN\` | per mode | From your secret store, never from this repository. |
| \`GHK_AUDIT_FILE\` | no | JSONL audit file (default: stdout). |
| \`GHK_CONTEXT_TOOLS\`, \`GHK_CONTEXT_SCOPE\` | no | The read-only \`bdd_*\` tools (default on, for callers with the \`bdd:read\` scope). |
| \`GHK_MAX_REQUEST_BYTES\`, \`GHK_MAX_RESPONSE_BYTES\` | no | Size limits (256 KB and 1 MB). |
| \`GHK_PUBLIC_URL\` | no | Public URL of \`/mcp\`, for the OAuth protected-resource metadata. |

## What every call goes through

1. The bearer token: signature (JWKS), issuer, audience, expiry. The tenant comes from the \`${manifest.identity.tenantClaim}\` claim, never from the arguments.
2. The tool's scopes (all of them) and roles (any of them). A caller sees only the tools it may call; any other name is "unknown".
3. The environment of the approval. A \`destructive\` or \`financial-critical\` tool needs a person to approve each call: this stateless runtime cannot ask, so it refuses them with a message.
4. The rate (\`@rate\`), the input JSON Schema and the size limits.
5. The service, at its approved handler only: no redirect, with \`Idempotency-Key\` (scoped to the caller), \`traceparent\` and \`baggage: ghk.scenario=…\`.
6. The response, as data, with secrets (and personal data for \`@pii\` tools) redacted. One audit line per decision.

## Build and run

\`\`\`bash
docker build -t ${slug(manifest.service.name)}-mcp .                              # AgentCore: docker buildx build --platform linux/arm64
docker run -p 8000:8000 --env-file runtime.env ${slug(manifest.service.name)}-mcp   # runtime.env holds references your platform resolves
\`\`\`
`;
}
