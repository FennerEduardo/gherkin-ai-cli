# Vendored tree-sitter grammars

`ghk reverse` parses Java, Kotlin, C#, Python and Go with [tree-sitter](https://tree-sitter.github.io/) through `web-tree-sitter` (a dependency, pinned to `0.25.10`, the newest release that loads these grammars). The grammars are loaded only when `ghk reverse` analyses code in one of these languages, never when the CLI starts.

Only the five grammars `ghk reverse` uses are copied here. The package they come from, `tree-sitter-wasms`, holds 36 grammars (50 MB).

| File | Grammar | Upstream | License | SHA-256 |
|---|---|---|---|---|
| `tree-sitter-java.wasm` | tree-sitter-java 0.20.x | https://github.com/tree-sitter/tree-sitter-java | MIT, © 2017 Ayman Nadeem ([text](licenses/tree-sitter-java.LICENSE)) | `637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f` |
| `tree-sitter-kotlin.wasm` | tree-sitter-kotlin 0.3.x | https://github.com/fwcd/tree-sitter-kotlin | MIT, © 2019 fwcd ([text](licenses/tree-sitter-kotlin.LICENSE)) | `b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449` |
| `tree-sitter-c_sharp.wasm` | tree-sitter-c-sharp 0.20.x | https://github.com/tree-sitter/tree-sitter-c-sharp | MIT, © 2014 Max Brunsfeld ([text](licenses/tree-sitter-c-sharp.LICENSE)) | `6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991` |
| `tree-sitter-python.wasm` | tree-sitter-python 0.21.x | https://github.com/tree-sitter/tree-sitter-python | MIT, © 2016 Max Brunsfeld ([text](licenses/tree-sitter-python.LICENSE)) | `9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b` |
| `tree-sitter-go.wasm` | tree-sitter-go 0.20.x | https://github.com/tree-sitter/tree-sitter-go | MIT, © 2014 Max Brunsfeld ([text](licenses/tree-sitter-go.LICENSE)) | `9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6` |

The WebAssembly builds come from [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) 0.1.13 (released into the public domain under the Unlicense, [text](licenses/tree-sitter-wasms.LICENSE)).

**Updating.**
1. Replace the files from a newer `tree-sitter-wasms` release, or build them with `tree-sitter build --wasm`.
2. Update the table: versions and hashes (`sha256sum *.wasm`).
3. Check that the pinned `web-tree-sitter` still loads every grammar. `tests/core/reverse-treesitter.test.ts` does this for each one. As of 2026-11-02, `web-tree-sitter` 0.27 rejects these builds and 0.25.10 accepts them.
