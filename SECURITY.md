# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 3.x | ✅ security fixes |
| 2.6.x | ⚠️ critical fixes only, until 2027-03-31 |
| < 2.6 | ❌ |

## Reporting a vulnerability

**Do not open a public issue.** Report privately through one of these channels:

1. GitHub: **Security → Report a vulnerability** on this repository (private advisory). This is the preferred channel.
2. Email: **security@gherkin-ai.com**.

Please include the affected version, the configuration needed to reproduce, steps or a proof of concept, and the impact you observed.

### What happens next

| Step | Target |
|---|---|
| Acknowledgement | within 2 business days |
| Triage and severity (CVSS v3.1) | within 5 business days |
| Fix for critical / high severity | within 30 days |
| Fix for medium / low severity | next minor release |

Fixes are released as patch versions and published with a GitHub Security Advisory. We request a CVE when one applies. Reporters are credited unless they prefer otherwise. Please give us 90 days, or until a fix is released if sooner, before public disclosure.

## In scope

We treat any of the following as a vulnerability:

- **MCP:** bypass of the server's least-privilege model, for example
  - running a write or destructive tool while it is disabled;
  - path arguments escaping the workspace;
  - clearing or forging audit records.
- **Credentials:** API keys written to disk, logs, telemetry or audit files; or a key sent to a provider other than the one it belongs to.
- **Prompt redaction:** secrets reaching an LLM provider despite redaction.
- **Web Studio:** access without the session token, cross-origin or DNS-rebinding access, or path traversal.
- **Agent writes:** LLM output written outside the workspace, or written while the dry-run, unattended-write or protected-branch guards apply.
- **Organization policy:** bypass of `locked` settings, provider or model allow-lists, or the plugin allow-list.
- **Supply chain:** issues in our release process, such as provenance or package contents.

## Security controls (overview)

Details are in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

- **Credentials.** Keys come from environment variables or the OS keychain only, and are resolved per provider. The CLI never writes them to disk.
- **Redaction.** Secrets are redacted from LLM prompts, log files and audit details. PII redaction is optional.
- **MCP.** The server is read-only by default. Write and destructive tools need explicit configuration. Every call checks path containment and the agent policy, and is audited.
- **Agent-driven changes.** They are dry-run by default. CI and protected-branch guards apply. Model-proposed paths outside the workspace are dropped.
- **Web Studio.** It binds to localhost and requires a per-session token, an exact Host match and a same-origin Origin. Commands run without a shell.
- **Releases.** They are published from CI with npm provenance and a CycloneDX SBOM. `npm audit --audit-level=high` blocks CI.

## Third-party dependencies

What a supply-chain scanner (e.g. Socket) reports for `gherkin-ai`, and why. Last reviewed for 3.2.1.

| Alert | Packages | Why it is there |
|---|---|---|
| Network access | LLM SDKs (`@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`, `openai`, `@google/genai`), `undici`, `@modelcontextprotocol/sdk`, `express` | The CLI reaches the network only through the LLM provider you configure, `ghk upgrade --cli` (npm registry), and the servers you start (`web`, `mcp`, `graph --serve`, on localhost). Provider SDKs are loaded only for the provider in use. In egress-restricted networks, allow only your provider's endpoint |
| Shell access | `ts-morph`, `inquirer` (`external-editor`, for `$EDITOR`), `@napi-rs/keyring`, `@google/genai` | The CLI's own commands (`verify`, `quality`, goldens) run your test commands. The agent firewall governs the agent's commands, not the internals of these libraries |
| `new Function` / install script | `protobufjs` (from `@google/genai`) | Compiles protobuf decoders at run time; its postinstall only checks the version. It is loaded only when the Gemini provider is used |
| Deprecated | `node-domexception` (from `@google/genai` → `google-auth-library` → `gaxios` → `node-fetch`) | A polyfill still pulled in by Google's SDK chain, up to its latest versions. It is not used on Node ≥ 22, where `DOMException` is global. 3.2.1 dropped the other path (`openai` 4 → `formdata-node`) by moving to `openai` 7 |
| Trivial packages | about 13 transitive micro-packages | Not direct dependencies of `gherkin-ai` |

Fixed in 3.2.1: `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5, high), now `zod` 4; also `undici`, `body-parser` and `fast-uri` advisories. `npm audit` reports 0 vulnerabilities.
