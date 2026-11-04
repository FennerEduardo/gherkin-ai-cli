# Plugins: extending gherkin-ai

A plugin adds what the core does not ship: an analyzer that reads a stack for `ghk reverse`, a lint rule of your organization, or a gateway provider for `ghk expose`. Plugins are ordinary npm packages (or files in the project). The core stays small, and a stack the maintainers do not support can still be read, linted and exposed.

> **Status in 3.3.0.** The plugin API is version 2. Its extension points are new in 3.3.0 and may still grow in a 3.3.x release. A plugin declares the API and the gherkin-ai versions it supports, so an incompatible plugin is refused with a clear error instead of misbehaving.

## Contents

1. [Loading plugins](#1-loading-plugins)
2. [Writing a plugin](#2-writing-a-plugin)
3. [Extension points](#3-extension-points)
4. [Compatibility](#4-compatibility)

## 1. Loading plugins

```json
{
  "plugins": {
    "load": ["@gherkin-ai/reverse-laravel", "./tools/acme-lint.js"],
    "allow": ["@gherkin-ai/reverse-laravel", "./tools/acme-lint.js"]
  }
}
```

- `plugins.load` lists npm package names, resolved from the project, or paths relative to the project. A relative path must stay inside the project.
- `plugins.allow` is the organization's allow-list. When it is set, any other plugin is refused with exit code 5 ([ENTERPRISE.md §10](ENTERPRISE.md#10-plugins)). Lock it at the organization level.
- Each load is recorded in the audit log (`plugin:load`).
- `ghk generate`, `ghk lint`, `ghk reverse` and `ghk stacks` load the project's plugins. None of them needs `ghk init`.

A plugin runs in the CLI's process, with the CLI's permissions. It is trusted code: review it as you review a dependency, and pin it with `plugins.allow`.

## 2. Writing a plugin

A plugin is a module that exports an object (`module.exports = plugin`, `export default plugin` or `export const plugin`), or a `register(registry)` function:

```js
// acme-lint.js
module.exports = {
  name: 'acme-lint',
  version: '1.0.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^3.3' },
  lintRules: () => [{
    id: 'ACME001',
    name: 'Scenarios name the actor',
    severity: 'warning',
    check: parsed => parsed.scenarios
      .filter(sc => !/^(A|An|The) \w+/.test(sc.name))
      .map(sc => ({ ruleId: 'ACME001', severity: 'warning', message: `Name the actor in "${sc.name}"`, scenario: sc.name }))
  }]
};
```

## 3. Extension points

| Hook | Since | What it adds | Used by |
|---|---|---|---|
| `analyze(ir)`, `generate(ir, config)`, `validate(artifacts)`, `mcpTools()`, `onInit(context)` | API 1 | analysis notes, generated files, validation, MCP tools | `ghk generate`, the MCP server |
| `reverseAnalyzers()` | API 2 | `SourceAnalyzer`s: `{ id, language, frameworks, maturity, extensions?, detect(ctx), analyze(ctx) }` returning Source Evidence IR | `ghk reverse scan` (and everything built on it), `ghk stacks` |
| `lintRules()` | API 2 | `LintRule`s: `{ id, name, severity, check(parsed, options) }` | `ghk lint`, the lint of `reverse` proposals |
| `gatewayProviders()` | API 2 | `GatewayProvider`s: `{ id, label, tier, maturity, capabilities(), plan(), emit() }` | `ghk expose` |

### Reverse analyzers

An analyzer receives the discovered files (`ctx.files`, relative and absolute paths; secrets and build output already left out) and returns evidence. Each item has:
- a `kind`: `http-endpoint`, `message-handler`, `scheduled-job`, `validation-rule`, `authorization-rule`, `error-condition`, `state-value`, `domain-event`, `success-response`, …;
- a `location` (file and lines), an `extractor` (its id) and a `confidence`;
- `references` to the endpoint it belongs to;
- `metadata`: for an endpoint `{ method, path, handler?, owner? }`.

[REVERSE.md](REVERSE.md) describes every kind. The candidates, proposals, `coverage`, `review` and `sync` work on that evidence whatever analyzer produced it.

- `extensions` asks discovery for file types it does not read by default (for example `.blade.php`).
- `maturity` is `experimental` or `beta`. `reverse scan --json` reports it with the plugin's name, and `ghk stacks` lists it.
- Evidence ids must be stable: the same fact found again gets the same id, so that two runs give identical output and review decisions survive a rescan.

## 4. Compatibility

- `apiVersion` is the plugin API the plugin is written for. Without it a plugin is API 1, and its hooks keep working. A plugin for a newer API than the CLI implements is refused when it is registered.
- `engines["gherkin-ai"]` is an npm-style range (`^3.3`, `>=3.3 <4`, `^3 || ^4`). A CLI version outside it refuses the plugin.

In both cases the error names the plugin and says why. Nothing of the plugin runs.
