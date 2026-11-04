# @gherkin-ai/reverse-rails

Ruby on Rails for [`ghk reverse`](https://github.com/FennerEduardo/gherkin-ai-cli/blob/main/docs/REVERSE.md): an official gherkin-ai plugin (plugin API 2, **beta**). It is kept out of the CLI package so its Ruby grammar (2 MB) is installed only by those who need it.

```bash
npm install --save-dev @gherkin-ai/reverse-rails
```

```json
{ "plugins": { "load": ["@gherkin-ai/reverse-rails"], "allow": ["@gherkin-ai/reverse-rails"] } }
```

## What it reads

- **Routes** (`config/routes.rb`), parsed with tree-sitter-ruby:
  - `resources` and `resource` with `only:`, `except:`, `path:` and `param:`;
  - nested resources, `member do … end`, `collection do … end`, and `get :feed, on: :collection`;
  - `namespace`, `scope`;
  - `get/post/put/patch/delete 'path', to: 'controller#action'`;
  - Devise `devise_for :users` (sign-in and sign-up, with `path_names`).
- **Controllers:**
  - `before_action :authenticate_user!` (and `:authenticate*`, `:require_login`) as authentication, with its `only:`/`except:`;
  - `params.require(:order).permit(…)` as the input.
- **Action bodies:**
  - failures: `render json: …, status: :not_found` and `head :conflict` behind `if`/`unless`, in block or modifier form, and `raise ActiveRecord::RecordNotFound`;
  - states written;
  - events: `ActiveSupport::Notifications.instrument`, `broadcast(:…)`, `publish(…)`;
  - success statuses.
- **Models:** `validates :email, presence: true, format: …, length: …` on the model whose params the controller permits.

## Validation

`ghk plugin verify` passes on the plugin's fixture (9 of 9 endpoints). On the [Rails RealWorld app](https://github.com/gothinkster/rails-realworld-example-app) at `a2ae4ff` it finds the 19 endpoints of the specification: precision 0.90, recall 1.00, F1 0.95. The two endpoints outside the specification are the `PATCH` routes Rails adds next to each `PUT`. The lowest lint score of its proposals is 94.

## Licenses

The plugin is MIT. Its grammar, `grammar/tree-sitter-ruby.wasm`, is tree-sitter-ruby 0.20 (MIT, © 2016 Rob Rix; [text](grammar/tree-sitter-ruby.LICENSE)), built by [tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms) 0.1.13 (Unlicense; [text](grammar/tree-sitter-wasms.LICENSE)). SHA-256 `93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39`.
