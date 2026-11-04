# @gherkin-ai/plugin-sdk

Types for [gherkin-ai](https://github.com/FennerEduardo/gherkin-ai-cli) plugins, plugin API 2: analyzers for `ghk reverse`, lint rules, and gateway providers for `ghk expose`.

```bash
npm install --save-dev @gherkin-ai/plugin-sdk gherkin-ai@^3.3
npx gherkin-ai@3 plugin new analyzer my-stack      # a working plugin with a fixture
npx gherkin-ai@3 plugin verify ./my-stack          # the conformance kit
```

```js
// index.js
const { definePlugin, defineAnalyzer } = require('@gherkin-ai/plugin-sdk');

module.exports = definePlugin({
  name: 'my-stack',
  version: '0.1.0',
  apiVersion: 2,
  engines: { 'gherkin-ai': '^3.3' },
  reverseAnalyzers: () => [defineAnalyzer({
    id: 'my-stack/routes',
    language: 'my-language',
    frameworks: ['my-framework'],
    maturity: 'experimental',
    extensions: ['.mylang'],
    detect: ctx => ctx.files.some(f => f.rel.endsWith('.mylang')),
    analyze: async ctx => {
      const { makeEvidence, normalisePath } = ctx.sdk;   // the CLI's own helpers: stable ids, normalised paths
      // const parser = await ctx.sdk.loadGrammar(require.resolve('./tree-sitter-mylang.wasm'));
      return [];
    }
  })]
});
```

The package has no runtime dependency. The CLI gives every analyzer its helpers in `ctx.sdk`:
- `makeEvidence` and `evidenceId`, the same stable ids as the built-in analyzers;
- `normalisePath` and `joinPaths`, which turn `:id` and `<int:pk>` into `{id}`;
- `isTestFile`;
- `loadGrammar(wasmPath)`, which parses with the CLI's web-tree-sitter;
- `tree`, the tree helpers.

So a plugin ships only its code, plus a `.wasm` grammar when it parses a language.

The full guide is [docs/PLUGINS.md](https://github.com/FennerEduardo/gherkin-ai-cli/blob/main/docs/PLUGINS.md).
