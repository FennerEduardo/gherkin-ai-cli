/* ==========================================================================
   gherkin-ai-cli - Templates of `ghk plugin new` (PLAN-3.3.0-reverse-plus EC-03)

   Each template is a working plugin that passes `ghk plugin verify` as
   generated: a reverse analyzer with a fixture and its expected endpoints,
   a lint rule, or a gateway provider. CommonJS, no build step, no runtime
   dependency (the CLI hands analyzers their helpers in ctx.sdk).
   ========================================================================== */

import { CLI_VERSION } from '../../version';

export type TemplateKind = 'analyzer' | 'lint-rule' | 'gateway';

const pkg = (name: string, description: string) => `${JSON.stringify({
  name,
  version: '0.1.0',
  description,
  license: 'MIT',
  main: 'index.js',
  keywords: ['gherkin-ai', 'gherkin-ai-plugin'],
  files: ['index.js', 'README.md'],
  peerDependencies: { 'gherkin-ai': `^${CLI_VERSION.split('.').slice(0, 2).join('.')}` },
  devDependencies: { '@gherkin-ai/plugin-sdk': '^2.0.0' },
  scripts: { verify: 'npx gherkin-ai plugin verify .' }
}, null, 2)}\n`;

const readme = (name: string, what: string) => `# ${name}

A gherkin-ai plugin (plugin API 2): ${what}.

\`\`\`bash
npx gherkin-ai@3 plugin verify .     # the conformance kit: run it before every release
\`\`\`

Load it in a project's \`gherkin-ai.config.json\`:

\`\`\`json
{ "plugins": { "load": ["${name}"] } }
\`\`\`

Guide: https://github.com/FennerEduardo/gherkin-ai-cli/blob/main/docs/PLUGINS.md
`;

export function pluginTemplate(kind: TemplateKind, name: string): Record<string, string> {
  const id = name.replace(/^@[^/]+\//, '').replace(/^gherkin-ai-/, '');
  if (kind === 'analyzer') {
    return {
      'package.json': pkg(name, `gherkin-ai reverse analyzer for ${id}`),
      'README.md': readme(name, `reads ${id} code for \`ghk reverse\``),
      'index.js': `'use strict';
/* A reverse analyzer for gherkin-ai. It reads "<METHOD> <path>" route lines from *.routes files: replace detect()
   and analyze() with what your stack needs. Build evidence with ctx.sdk so ids are stable across runs. For a real
   language, ship its tree-sitter grammar and parse with: const parser = await ctx.sdk.loadGrammar(require.resolve('./tree-sitter-x.wasm')). */
const fs = require('fs');

const ID = '${id}/routes';

module.exports = {
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^${CLI_VERSION.split('.').slice(0, 2).join('.')}' },
  reverseAnalyzers: () => [{
    id: ID,
    language: '${id}',
    frameworks: ['${id}'],
    maturity: 'experimental',
    extensions: ['.routes'],
    detect: ctx => ctx.files.some(f => f.rel.endsWith('.routes')),
    analyze: async ctx => {
      const { makeEvidence, normalisePath } = ctx.sdk;
      const out = [];
      for (const f of ctx.files.filter(x => x.rel.endsWith('.routes'))) {
        const lines = fs.readFileSync(f.abs, 'utf8').split('\\n');
        lines.forEach((line, i) => {
          const m = line.match(/^\\s*(GET|POST|PUT|PATCH|DELETE)\\s+(\\S+)(?:\\s+(\\w+))?/);
          if (!m) return;
          const p = normalisePath(m[2]);
          const location = { file: f.rel, startLine: i + 1, endLine: i + 1 };
          const endpoint = makeEvidence({ kind: 'http-endpoint', extractor: ID, confidence: 'strong', location, description: m[1] + ' ' + p, symbol: m[3], metadata: { method: m[1], path: p, handler: m[3] }, key: m[1] + ' ' + p });
          out.push(endpoint);
          out.push(makeEvidence({ kind: 'success-response', extractor: ID, confidence: 'inferred', references: [endpoint.id], location, description: 'responds ' + (m[1] === 'POST' ? 201 : 200), metadata: { status: m[1] === 'POST' ? 201 : 200 } }));
        });
      }
      return out;
    }
  }]
};
`,
      'fixtures/example/app.routes': 'POST /orders placeOrder\nGET /orders/:id getOrder\nPOST /orders/:id/cancel cancelOrder\n',
      'fixtures/example.expected.json': `${JSON.stringify({ endpoints: ['POST /orders', 'GET /orders/{id}', 'POST /orders/{id}/cancel'] }, null, 2)}\n`
    };
  }
  if (kind === 'lint-rule') {
    return {
      'package.json': pkg(name, `gherkin-ai lint rules: ${id}`),
      'README.md': readme(name, 'adds lint rules to `ghk lint` and to the lint of `ghk reverse` proposals'),
      'index.js': `'use strict';
/* Lint rules for gherkin-ai. Ids are your own (a prefix and three digits), never GHKnnn. */
module.exports = {
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^${CLI_VERSION.split('.').slice(0, 2).join('.')}' },
  lintRules: () => [{
    id: 'ORG001',
    name: 'Scenario names start with a verb or an actor',
    severity: 'info',
    check: parsed => parsed.scenarios
      .filter(sc => /^(Test|Check|Verify)\\b/i.test(sc.name))
      .map(sc => ({ ruleId: 'ORG001', severity: 'info', message: 'Name the behaviour, not the test: "' + sc.name + '"', scenario: sc.name, suggestion: 'Start with the actor or the action: "A customer places an order".' }))
  }]
};
`
    };
  }
  return {
    'package.json': pkg(name, `gherkin-ai expose gateway provider: ${id}`),
    'README.md': readme(name, 'emits the gateway configuration `ghk expose` deploys'),
    'index.js': `'use strict';
/* A gateway provider for \`ghk expose\`. It turns the approved capability manifest into the files its gateway needs.
   It never applies them. Declare every control honestly: native (the gateway enforces it), runtime (gherkin-ai's
   generated MCP runtime does) or unsupported. Never claim a control the gateway does not provide. */
module.exports = {
  name: ${JSON.stringify(name)},
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^${CLI_VERSION.split('.').slice(0, 2).join('.')}' },
  gatewayProviders: () => [{
    id: '${id}',
    label: '${id}',
    tier: 'community',
    maturity: 'experimental',
    capabilities: () => ({
      'inbound-auth': 'runtime', 'per-tool-authz': 'runtime', 'tenant-isolation': 'runtime', 'outbound-credentials': 'unsupported',
      'rate-limit': 'unsupported', 'human-approval': 'runtime', audit: 'runtime', 'private-network': 'unsupported', 'tool-discovery': 'unsupported'
    }),
    plan: (manifest, options) => ({
      provider: '${id}',
      tools: manifest.capabilities.filter(c => c.status === 'approved').map(c => ({ tool: c.name, effect: c.effect, scopes: c.authorization.scopes, approval: c.execution.approval, controls: { 'inbound-auth': 'runtime', 'per-tool-authz': 'runtime' } })),
      resources: ['gateway route for ' + manifest.service + ' (' + options.environment + ')'],
      warnings: ['Outbound credentials, rate limits and private networking are not handled by this provider.']
    }),
    emit: (manifest, options) => [{
      path: 'gateway.json',
      content: JSON.stringify({ service: manifest.service, environment: options.environment, tools: manifest.capabilities.filter(c => c.status === 'approved').map(c => ({ name: c.name, description: c.description, scopes: c.authorization.scopes })) }, null, 2) + '\\n'
    }]
  }]
};
`
  };
}
