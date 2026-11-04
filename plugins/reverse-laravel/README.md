# @gherkin-ai/reverse-laravel

Laravel for [`ghk reverse`](https://github.com/FennerEduardo/gherkin-ai-cli/blob/main/docs/REVERSE.md): an official gherkin-ai plugin (plugin API 2, **beta**). It is kept out of the CLI package so its PHP grammar (800 KB) is installed only by those who need it.

```bash
npm install --save-dev @gherkin-ai/reverse-laravel
```

```json
{ "plugins": { "load": ["@gherkin-ai/reverse-laravel"], "allow": ["@gherkin-ai/reverse-laravel"] } }
```

```bash
npx gherkin-ai@3 reverse scan       # laravel/routes is listed with its maturity and this plugin
npx gherkin-ai@3 reverse propose
```

## What it reads

- **Routes**, parsed with tree-sitter-php:
  - `Route::get/post/put/patch/delete`, `Route::match([...])`, `Route::any`;
  - `Route::apiResource`, `Route::resource`: dot-nested or as a path (`articles/{article}/comments`), with `only`/`except` chained or in the options array;
  - the prefixes and middleware of every enclosing `->prefix()->middleware()->group(…)` or `Route::group([...], …)`;
  - the `/api` prefix of `routes/api.php`.
- **Handlers:** `[OrderController::class, 'cancel']`, `'OrderController@cancel'`, `'Api\\ArticleController'`.
- **Security:** `auth`, `auth:sanctum` and `auth:api` (401); `role:`, `can:` and `ability:` (403).
- **Controller bodies:**
  - failures: `abort(404, '…')`, `abort_if`/`abort_unless`, `if (…) return response()->json(…, 409)`, `throw new …Exception`;
  - states written;
  - events: `event(new OrderPlaced(…))`, `OrderPlaced::dispatch(…)`;
  - success statuses.
- **Input:** the `FormRequest` an action takes, and its `rules()`.

## Validation

`ghk plugin verify` passes on the plugin's fixture (6 of 6 endpoints). On the [Laravel RealWorld app](https://github.com/gothinkster/laravel-realworld-example-app) at `e45c37c` it finds the 19 endpoints of the specification: precision 0.86, recall 1.00, F1 0.93. Three endpoints are outside the specification and exist in the code: a `GET /` web route, and the `PATCH` routes that `resource` and `match` add. The lowest lint score of its proposals is 94.

## Licenses

The plugin is MIT. Its grammar, `grammar/tree-sitter-php.wasm`, is tree-sitter-php 0.22 (MIT, © 2017 Josh Vera, GitHub; [text](grammar/tree-sitter-php.LICENSE)), built by [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) 0.1.13 (Unlicense; [text](grammar/tree-sitter-wasms.LICENSE)). SHA-256 `55bb617b6f01e14bab997861f0b20a2420cf6ba3199ffeb295b9ec398966d8a3`.
