# Migrating to 3.3

3.3 adds `ghk reverse` (beta), which reads an existing codebase and proposes specifications from it ([REVERSE.md](REVERSE.md)). It is opt-in: no command changes behaviour unless you run it.

The configuration does not have to change. The CLI contract (commands, flags, exit codes, `--json` shapes) is unchanged, apart from the new `reverse` command and the new optional `reverse` section of the configuration.

## Command names derived from features

Running `ghk reverse` on real projects exposed two naming defects. They date from 3.2.2 or earlier and are fixed in 3.3. They only affect features that do not declare their commands with `@command:` tags.

| Id | 3.2.2 | 3.3 |
|---|---|---|
| IR-05 | A relative clause stayed in the command name: "When the customer cancels an order **that** does not exist" gave `CancelOrderThat`, next to the real `CancelOrder` | The noun phrase ends at *that / which / who / whose / where / when* (and *que / cuyo / donde / cuando*). It gives `CancelOrder`. A demonstrative is skipped like an article ("approves that request" → `ApproveRequest`) |
| IR-06 | A business verb outside the core list ("places", "opens", "reserves", "confirms"…) named a command only when no core verb did. "places an order" next to "cancels the order" gave only `CancelOrder` | It names its own command (`PlaceOrder` and `CancelOrder`). Three rules keep it from adding noise next to core commands: a synonym of a core verb on the same noun is the same command ("places an order" + "creates an order" → `CreateOrder` only); a verb that repeats its noun ("grades the grade") is left out; and so is a read ("requests the members") |

**Measured impact on 39 real features** (16 reference projects and the LMS):
- The 16 reference projects are unchanged.
- 4 LMS features gain a command, and their events now pair with the right commands. For example, `workspace_onboarding.feature` goes from `ApproveDataProtection → InstitutionCreated` to `OpenWorkspace → InstitutionCreated` and `ApproveDataProtection → DataControllerTermsAccepted`. The new names (`OpenWorkspace`, `ReserveSeat`, `ConfirmActivationLink`, `InviteMemberInvitation`) match what the services' code already does.

**What to do:**
- In a generated project, regenerate. The kernel gains the new command and its contracts gain the new operation.
- In a project marked `.ghk-implemented`, the new kernel and contracts arrive as `.ghk-new` files to merge, as usual.
- To keep exactly the 3.2 names, declare them with `@command:` tags; declared commands are never re-derived.
- `ghk lint --explain-ir` shows the names a feature produces before you regenerate.

## From 3.2.2 to 3.3.0

| What | 3.2.2 | 3.3.0 | Do |
|---|---|---|---|
| Installed size | 1.9 MB packed, 6.2 MB unpacked | 2.7 MB packed, 15.5 MB unpacked, plus the `web-tree-sitter` dependency (5.7 MB). The tree-sitter grammars used by `ghk reverse` are in `vendor/tree-sitter/` | – |
| Default model of `llm.provider: "gemini"` | `gemini-2.5-pro` (404 for new API keys) | `gemini-flash-lite-latest` | to keep another model, set `llm.model` or `LLM_MODEL` |
| Command names of undeclared features | see IR-05 / IR-06 above | see above | regenerate, or add `@command:` tags |
| `stack.database: "mysql"` without `stack.kernelDatabase` | the kernel ran on PostgreSQL, but the compose file, `.env.example` and Prisma used MySQL | all use PostgreSQL, and `generate` warns | to run on MySQL, set `stack.kernelDatabase: "mysql"` (NestJS, Express, Spring Boot, Quarkus, FastAPI, Django, ASP.NET Core and Go in 3.3.0); otherwise set `stack.database: "postgresql"` to say what the service runs on |
| `stack.database: "mongodb"` without `stack.kernelDatabase` | the compose file used `mongo:7.0` with a root user and `.env.example` a `mongodb://` URL, for a kernel that speaks PostgreSQL; Prisma 7 was rejected | PostgreSQL everywhere, `generate` warns, Prisma 7 is accepted | to run on MongoDB, set `stack.kernelDatabase: "mongodb"` (every core runtime in 3.3.0); otherwise set `stack.database: "postgresql"` |
| `stack.kernelDatabase: "mongodb"` (new) | – | compose runs `mongo:8.0` as a single-node replica set without authentication; `DATABASE_URL` names the replica set (`directConnection=true` from the host) | managed MongoDB (Atlas, Cosmos DB vCore) is a replica set already: use its URL |
| Generated Python `pyproject.toml` | `pytest>=8.3,<9.2`, `pytest-bdd>=7.3` | `pytest>=8.3`, `pytest-bdd>=9.0.1` | regenerate, or edit the two lines |
| `converge` on a generated feature whose step definitions are all still the pending stubs, with no coverage report | Code Coverage "n/a", left out of the score: the scaffold could converge | Code Coverage 0, with the reason; the overall score drops and may exit 7 | implement the steps (or run the tests with coverage). In CI for a fresh scaffold, expect exit 7 until the behaviour exists |
| `ghk stacks` (text output) | generation stacks | also lists the `ghk reverse` analyzers and their maturity; the `--json` output is unchanged | – |
