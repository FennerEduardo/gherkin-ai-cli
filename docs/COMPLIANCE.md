# Compliance mapping: ISO/IEC 42001, SOC 2 and the EU AI Act

This page maps what gherkin-ai does to the controls that auditors ask about when a team uses AI coding agents. It is for the people who assemble the evidence: security, compliance and platform teams.

Read it with three limits in mind:

- **gherkin-ai is a development tool, not a management system.** It produces evidence for some controls. It does not make an organization compliant with any of these frameworks, and it has not been audited or certified against them.
- **Applicability is yours to decide.** For example, most EU AI Act obligations fall on providers and deployers of *high-risk* AI systems (Annex III). An AI coding agent used to write ordinary business software is usually not one. Your legal team decides what applies.
- **Each row names the code that implements the control**, so a reviewer can check the claim. "Not covered" rows are as important as the others.

## Controls gherkin-ai provides

| Control | What it does | Where (code, docs) | Evidence you can export |
|---|---|---|---|
| **Agent firewall** | Decides ALLOW, REQUIRE_APPROVAL or DENY for each file write, command, network host, secret and MCP tool an agent asks for, before it runs. Self-protecting: the agent cannot edit the policy | `src/core/governance/agent-firewall.ts`, `shell-command.ts`; [ENTERPRISE.md §14](ENTERPRISE.md#14-agent-firewall) | Audit records `*:agent-write` with status `BLOCKED`; `ghk firewall policy --json` |
| **Proposal-first writes** | `verify --auto-fix` and `autopilot` produce patches by default; `--apply` in CI needs `--allow-unattended-writes`; protected branches refuse writes (exit 5) | `src/core/governance/write-guard.ts`, `agent-changes.ts`; [ENTERPRISE.md §6](ENTERPRISE.md#6-agent-driven-code-changes) | `.ghe/patches/*.patch`, audit records |
| **Least-privilege MCP server** | Read-only by default; write tools are not even listed unless `mcp.allowWrite` | `src/mcp/`; [ENTERPRISE.md §7](ENTERPRISE.md#7-mcp-server) | Audit records `mcp:<tool>` |
| **Organization policy layer** | Providers, models, endpoints, plugins and keys the organization allows or locks; a project cannot override a locked key | `src/core/config/loader.ts` (`locked`, `allowedModels`); [ENTERPRISE.md §1](ENTERPRISE.md#1-configuration-layers-and-organization-policy) | `ghk config show --json` (with the layer each value comes from) |
| **Model pinning and provider choice** | Exact model per provider; Azure OpenAI, Vertex AI, Bedrock-compatible gateways and Ollama keep data in an approved boundary | `src/core/llm/`; [ENTERPRISE.md §2](ENTERPRISE.md#2-llm-providers) | Audit records `llm:call` (provider/model), telemetry tokens |
| **Secret redaction** | Secrets and credentials are removed from prompts, logs, telemetry and audit details | `src/core/security/index.ts` (`redactSensitive`), `src/core/telemetry.ts` | – |
| **Sandboxed verification** | Tests the agent wrote run in a container without network, 2 GB / 2 CPU / 512 processes, without LLM or cloud credentials; commands run without a shell | `src/core/execution-sandbox.ts`; [SECURITY.md](../SECURITY.md) | `verify --json` |
| **Specification gates** | Lint score (exit 4), convergence and contract drift (exit 7), delivery risk (exit 4 at `--fail-on`), industry rules | `src/core/specification-linter.ts`, `convergence-engine.ts`, `contract-drift.ts`, `risk-engine.ts` | `lint --json`, `converge --json`, `risk --json`, `ghk report` |
| **Traceability** | Requirement → scenario → command / event / endpoint → code → tests | `src/core/graph/`; [ENTERPRISE.md §16](ENTERPRISE.md#16-traceability-graph-and-spec-kit) | `ghk graph --format json` |
| **Audit trail** | Append-only, redacted, per execution id; exportable for a SIEM | `src/core/telemetry.ts`, `src/commands/audit-export.ts`; [ENTERPRISE.md §9](ENTERPRISE.md#9-audit-trail-and-telemetry) | `ghk audit export --format jsonl\|csv\|ocsf` |
| **Supply chain of the tool** | `npm audit` gate, pinned CI actions, provenance and SBOM on release, packaged tarball verified before publish | `.github/workflows/`, `scripts/release-preflight.js`; [ENTERPRISE.md §13](ENTERPRISE.md#13-verifying-releases) | npm provenance, CycloneDX SBOM |

## ISO/IEC 42001:2023 (AI management system)

References are to Annex A controls.

| Annex A control | gherkin-ai evidence | Gap you fill |
|---|---|---|
| A.2 Policies related to AI | Organization configuration layer: what agents and models may be used, locked keys | The written AI policy itself |
| A.4 Resources for AI systems | Model and provider inventory (`allowedModels`, audit `llm:call`) | Data, tooling and people resources |
| A.5 Assessing impacts of AI systems | Delivery risk per change (`ghk risk`), industry rules | The impact assessment of the systems you build |
| A.6.2.2 AI system requirements and specification | Gherkin features as the specification, linted and versioned | – |
| A.6.2.4 Verification and validation | Convergence, contract drift, sandboxed tests, golden builds | Validation with users |
| A.6.2.5 Deployment | Proposal-first writes, protected branches, `quality` gate | Your release approval process |
| A.6.2.6 Operation and monitoring | – (gherkin-ai does not run in production) | Production monitoring |
| A.6.2.7 Technical documentation | Contracts, ADRs, traceability graph | – |
| A.6.2.8 Recording of event logs | Audit trail (`ghk audit export`) | Retention and review |
| A.7 Data for AI systems | Secret redaction in prompts | Data quality and provenance of training data (not applicable to a coding tool's users) |
| A.9 Use of AI systems | Agent firewall, MCP least privilege, human approval paths | Acceptable-use rules for people |
| A.10 Third-party and customer relationships | Provider allow-list, model pinning | Supplier agreements with LLM providers |

## SOC 2 (Trust Services Criteria 2017, revised points of focus 2022)

| Criterion | gherkin-ai evidence |
|---|---|
| CC3.2 / CC3.4 Risk identification, changes that affect controls | `ghk risk` per change, with weights and evidence |
| CC6.1 Logical access | Agent firewall, MCP read-only default, organization locks |
| CC6.8 Prevent unauthorized or malicious software | Plugin allow-list (`plugins.allow`), firewall command parsing, sandbox |
| CC7.2 Monitor for anomalies | Audit trail with denials (`BLOCKED`), OCSF export to the SIEM |
| CC8.1 Change management | Specification gates, contract drift, proposal-first writes, protected branches, PR report (`ghk report`) |
| CC9.2 Vendor and business partner risk | Provider and model allow-lists, pinned model versions |
| PI1.x Processing integrity (if in scope) | Contract coverage and convergence of the services you generate |

## EU AI Act (Regulation (EU) 2024/1689)

Check first whether the system you build is high-risk (Article 6, Annex III). The articles below apply to providers of high-risk systems. gherkin-ai helps document how AI-assisted *code* for such a system was specified, changed and verified.

| Article | gherkin-ai evidence | Not covered |
|---|---|---|
| Art. 4 AI literacy | – | Training of the staff who use agents |
| Art. 9 Risk management | Delivery risk per change, industry rules, gates in CI | The system-level risk management process |
| Art. 11 and Annex IV Technical documentation | Specifications, contracts, ADRs, traceability graph | Everything about the model itself, if you train or integrate one |
| Art. 12 Record-keeping | Audit trail of agent actions during development | Logging by the deployed system |
| Art. 14 Human oversight | REQUIRE_APPROVAL paths, proposal-first writes, `quality` gate requiring approval | Oversight of the deployed system |
| Art. 15 Accuracy, robustness and cybersecurity | Sandboxed verification, integration suite IT1–IT7 of generated services, DB TLS, image scan in generated CI | Accuracy metrics of an AI model |
| Art. 50 Transparency obligations | – | Disclosure to end users of AI interaction or generated content |

## Not covered by gherkin-ai

- Organizational processes: the AI policy, roles, training, management review, internal audit.
- Anything at runtime in production: gherkin-ai stops at build and deploy.
- Model governance: evaluation of the LLM itself, bias, data provenance.
- Identity: SSO, SCIM, workload identity (SPIFFE/SPIRE). The MCP server runs locally over stdio and does not implement OAuth for remote MCP.
- Data residency guarantees beyond choosing a provider endpoint in an approved region.
