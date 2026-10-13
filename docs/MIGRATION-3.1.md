# Migrating from 3.0 to 3.1

3.1 turns the generated backends into services you can keep: several features per service, an application layer wired to the runtime kernel, and generation that never overwrites implemented code. Nothing in `gherkin-ai.config.json` has to change. The generated output does change, so plan one regeneration per service.

Start with:

```bash
ghk generate -f features/<feature>.feature --dry-run   # what would be created, updated or kept, per file
ghk upgrade                                            # the full upgrade report
```

## What changes in the generated code

| Area | 3.0 | 3.1 |
|---|---|---|
| HTTP layer | Placeholders (MediatR handlers, JPA outbox, NestJS CQRS module, in-memory stores) not connected to the kernel. | `POST /api/v1/<feature>/{id}/{command}` runs the runtime kernel's `CommandService`: idempotency key, outbox, `traceparent`. 202 created, 200 replayed, 409 in progress, 422 domain error. |
| Tenant | Taken from the `X-Tenant-Id` header, `"default"` when missing. | Taken only from a validated HS256 bearer token (`JWT_SECRET`, claim `security.tenantClaim`, default `tenant_id`). No token or no tenant: 401. `X-Tenant-Id` is ignored. |
| Outbox publishing | Not wired. | A relay worker publishes the outbox (in-process for NestJS, Express, Spring, ASP.NET Core, FastAPI, Go, Phoenix and Axum; `manage.py outbox_relay`, `artisan outbox:relay`, `rails outbox:relay` otherwise). |
| Several features | Service-wide files (contracts, runtime, routes, Prisma schema) described only the last generated feature. | Each feature owns `contracts/<feature>/`; the root `openapi.json` / `asyncapi.json`, the Prisma schema, the runtime command service registry and the service routes cover every generated feature. |
| RabbitMQ topology | `<feature>.events` / `.consumer` / `.dlx` / `.dlq`. | `<service>.events` / … (service = `projectName`), shared by every aggregate. |
| Regeneration | Overwrote every file. | Overwrites a file only if it is unchanged since it was generated; otherwise writes `<file>.ghk-new`. |

## Steps

1. **Set the token secret.** Add `JWT_SECRET` to the service environment (`.env.example` lists it). If your identity provider puts the tenant in another claim, set it:

   ```json
   { "security": { "tenantClaim": "org_id" } }
   ```

   Clients that sent `X-Tenant-Id` must send a bearer token carrying the tenant instead.

2. **Protect what you implemented.** Generation already keeps edited files (checksum in `.ghe/inventory.json`). To keep files that are not in the inventory, or whole folders, list them:

   ```json
   { "generation": { "protect": ["src/domain/**", "src/**/*.service.ts"] } }
   ```

   A `.ghk-implemented` file at the project root (the LMS convention) protects every existing file. `--force` overwrites anyway.

3. **Regenerate every feature** of the service, one `ghk generate -f <feature>` per feature (order does not matter; each run includes the features already generated). Then:
   - merge each reported `<file>.ghk-new` into your file, or delete it;
   - delete the 3.0 placeholders you never edited. `ghk upgrade --apply --prune` removes them when the inventory proves they are unedited. The removed generators are NestJS `cqrs`, `outbox`, `saga`, `idempotency` and the `X-Tenant-Id` middleware; Java `CQRS`, `Outbox`, `Saga`, `Idempotency` and `MultiTenancy`; the .NET MediatR handlers, MassTransit saga, EF outbox/inbox, `HttpHeaderTenantService` and Testcontainers mock; the Django ORM outbox; and the Go/Python pattern packages.

4. **Rust only:** the domain moved from `src/domain.rs` to `src/domain/mod.rs` plus one module per feature. Delete `src/domain.rs` (Rust refuses both).

5. **Naming (optional).** JVM packages and the .NET namespace can be set explicitly:

   ```json
   { "generation": { "package": "com.acme.billing", "groupId": "com.acme" } }
   ```

6. **Verify against real infrastructure:**

   ```bash
   ghk verify --services      # PostgreSQL 17 + RabbitMQ 4, runs the stack's integration suite
   ghk converge --all         # every feature of every project in the repository
   ```

## Kernel updates from now on

`ghk upgrade --kernel` regenerates only the runtime kernel with the installed CLI: unedited kernel files are replaced, edited ones get `.ghk-new`. `--all` covers every project under the current directory; `--dry-run` only reports.

## Lint

A new rule, GHK015, warns when a command or aggregate name contains digits, looks like example data, or has more than four words. Fix it with an `@aggregate:<Name>` tag or an explicit `"<Name>Command"` in the When step. Quoted example values (`"MATH-101"`) are no longer reported by GHK006 / GHK007.
