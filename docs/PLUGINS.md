# Plugins: extending gherkin-ai

A plugin adds what the core does not ship: an analyzer that reads a stack for `ghk reverse`, a lint rule of your organization, or a gateway provider for `ghk expose`. Plugins are ordinary npm packages (or files in the project). The core stays small, and a stack the maintainers do not support can still be read, linted and exposed.

> **Status in 3.3.0.** The plugin API is version 2. Its extension points are new in 3.3.0 and may still grow in a 3.3.x release. A plugin declares the API and the gherkin-ai versions it supports, so an incompatible plugin is refused with a clear error instead of misbehaving.

## Contents

1. [Loading plugins](#1-loading-plugins)
2. [Writing a plugin](#2-writing-a-plugin)
3. [Extension points](#3-extension-points)
4. [Compatibility](#4-compatibility)
5. [Start, verify, list](#5-start-verify-list)
6. [Integrity and security](#6-integrity-and-security)
7. [The SDK](#7-the-sdk)
8. [Official plugins](#8-official-plugins)

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

The quickest start is `ghk plugin new` ([§5](#5-start-verify-list)), which writes a plugin that passes the conformance kit as generated. A plugin is a module that exports an object (`module.exports = plugin`, `export default plugin` or `export const plugin`), or a `register(registry)` function:

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

## 5. Start, verify, list

```bash
ghk plugin new analyzer gherkin-ai-reverse-mystack     # or lint-rule, gateway; --dir to choose where
ghk plugin verify ./gherkin-ai-reverse-mystack         # the conformance kit: exit 4 when a check fails
ghk plugin list                                        # the project's plugins and what each adds
ghk plugin lock                                        # pin their bytes in .ghk/plugins.lock
```

`ghk plugin new` writes `package.json`, `index.js` and a README. An analyzer also gets a fixture (`fixtures/example/`) and its expected endpoints (`fixtures/example.expected.json`). The template passes `verify` as generated.

`ghk plugin verify <dir>` loads the plugin into a registry of its own and checks the following. A failed check exits 4 and says what to change.

| For | Checks |
|---|---|
| every plugin | it exports a plugin; it is compatible with this gherkin-ai; it declares `apiVersion: 2` and `engines`; it contributes something |
| an analyzer, on each `fixtures/<name>/` | `detect()` recognises it; two runs give identical evidence; each item has an id, a known kind, a location inside the fixture, its own analyzer id as extractor, and a confidence. The fixture is watched while the analyzer runs: nothing may be written, nothing read outside the fixture and the plugin, and a `.env` planted next to the code must never be opened or appear in the output. Then endpoint precision, recall and F1 against `<name>.expected.json`. The lowest F1 decides the maturity it may claim: beta from 0.80, experimental from 0.60. |
| a lint rule | an id of its own (a prefix and three digits, never `GHKnnn`), a valid severity, a `check` that returns diagnostics on a sample feature, unique ids |
| a gateway provider | every control declared (`native`, `runtime` or `unsupported`); `plan` and `emit` deterministic; no control claimed `native` beyond `capabilities()`; emitted paths inside their directory; with `--run-tools`, its `validateCommand` (`terraform validate`, `bicep build`) passes on the files |

Run `verify` in the plugin's CI before every release.

## 6. Integrity and security

`plugins.allow` decides which plugins may load. Integrity decides which bytes:
- `ghk plugin lock` writes `.ghk/plugins.lock` with a sha512 of each plugin of `plugins.load` as it is on disk: the package directory of an npm plugin (without `node_modules`), or the file of a path plugin. Commit it.
- `plugins.integrity` (`{ "<specifier>": "sha512-…" }`) pins the same values in the configuration, where the organization can lock them. It takes precedence over the lock file.
- A pinned plugin whose bytes differ is refused before it runs, with exit code 5, and the refusal is audited (`plugin:load`, `BLOCKED`). A plugin without a pinned value loads as before.

A plugin is code running in the CLI's process with its permissions. Nothing sandboxes it, and gherkin-ai does not claim otherwise. `plugins.allow`, integrity and the audit log are how an organization controls what runs. The `mcpTools()` of a plugin are not served by `ghk mcp`. Any tool the MCP server does not know is classified `destructive`, so it needs explicit approval.

## 7. The SDK

`@gherkin-ai/plugin-sdk` gives editors the types of plugin API 2: `definePlugin`, `defineAnalyzer`, `defineLintRule` and `defineGatewayProvider`, plus every type the hooks use. It has no runtime dependency.

The CLI hands each analyzer its helpers in `ctx.sdk`:
- `makeEvidence` and `evidenceId`: the same stable ids as the built-in analyzers;
- `normalisePath` and `joinPaths`;
- `isTestFile`;
- `loadGrammar(wasmPath)`: parses with the CLI's own web-tree-sitter, so a plugin ships only its `.wasm` grammar;
- `tree`: `ofType`, `childOfType`, `lineRange`, `unquote`.

The types come from `gherkin-ai/dist/plugin-api`, the one public module of the CLI for plugins. The rest of `dist/` is internal.

## 8. Official plugins

The maintainers develop these in the repository (`plugins/`). They are published as separate npm packages, never inside the CLI's. Each one passes `ghk plugin verify`, and the golden `tests/golden/reverse-plugins.test.ts` runs them on every change.

| Package | Adds | Maturity | Validation |
|---|---|---|---|
| `@gherkin-ai/reverse-laravel` | `laravel/routes`: routes and groups, resources, controllers, FormRequests (tree-sitter-php, 800 KB, shipped in the plugin) | beta | F1 0.93 on the Laravel RealWorld app |
| `@gherkin-ai/reverse-rails` | `rails/routes`: `routes.rb`, controllers, strong params, model validations, Devise (tree-sitter-ruby, 2 MB, shipped in the plugin) | beta | F1 0.95 on the Rails RealWorld app |
| `@gherkin-ai/expose-azure-apim` | gateway provider `azure-apim` for `ghk expose`: an API on an existing Azure API Management instance in front of the generated MCP runtime, with `validate-jwt` and `rate-limit-by-key` (Terraform, `azurerm`) | experimental | `terraform fmt -check` and `validate`; never applied |
| `@gherkin-ai/expose-gcp` | gateway provider `gcp-apigateway` for `ghk expose`: Google Cloud API Gateway in front of the generated MCP runtime, with JWT validation from the OIDC JWKS (Terraform, `google-beta`) | experimental | `terraform fmt -check` and `validate`; never applied |

The two gateway providers are templates for 3.3: the runtime still enforces per-tool authorization, tenants and approvals, and the full providers are planned for 3.4 ([EXPOSE.md §6](EXPOSE.md#6-gateway-providers)). The golden `tests/golden/expose-plugins.test.ts` runs them through the conformance kit and through `expose plan` and `expose generate` from a project's `plugins.load`.

The [golden-build dashboard](https://fennereduardo.github.io/gherkin-ai-cli/goldens.html#plugins) lists them with their maturity, their F1 on the open-source corpus, and the conformance kit, which runs again on every build of the page. Community plugins use the keyword `gherkin-ai-plugin` on npm. Run `ghk plugin verify` on a plugin before you load it. Its report shows what it reads, whether it is deterministic, and the maturity its fixtures support.
