# Industry profiles

An industry profile turns a reference standard into rules that `ghk` enforces and that AI agents follow. A project opts in with `industry.id`:

```json
{ "industry": { "id": "banking", "disabledRules": ["GHK104"] } }
```

```bash
ghk init --industry banking        # new project (also asked interactively)
ghk industry apply health          # existing project
ghk industry list | show <id> [--json]
```

> Compliance items (PCI DSS, HIPAA, ISO 26262, ...) are engineering guidance, not legal advice or certification.

## What a profile changes

| Where | Effect |
|---|---|
| `ghk lint` (and `converge`, MCP `lint_specification`) | Adds the profile rules plus GHK090. Use `industry.disabledRules` to skip a rule |
| Semantic IR | Adds one `must` compliance constraint per profile rule and a governance policy. It adds no commands or events |
| `ghk implement` | Master prompt gets an **Industry Standards** section. With `--compact` it gets one paragraph and a pointer to `.ghe/industry-context.md` |
| Agent prompts (`generate`) | Each agent gets `[MANDATORY] Industry Standards` |
| Contracts | OpenAPI/AsyncAPI `info.x-industry` (`id`, `standards`, `classification` from the feature tags); the ADR gets an **Industry Standards** section |
| Agent firewall | The profile's sensitive paths (PHI, payments, OTA, ...) require human approval |
| `.ghe/industry-context.md` / `.json` | Written by `init`, `generate`, `implement` and `industry apply`; schema in `schemas/industry-context.schema.json` |
| MCP | Tool `get_industry_profile` (defaults to the project industry) |

`domainProfile` keeps working as before. A legacy value such as `"payments"` does **not** turn on an industry: `ghk upgrade` only suggests `ghk industry apply banking`.

## Profiles and rules

Rules read only the parsed specification: tags, scenario names and step text. Quoted example values are ignored unless the rule says otherwise. Keyword lists cover English and Spanish specifications.

| Industry (`id`) | Standards | Rules |
|---|---|---|
| `banking` | BIAN Service Landscape 12, ISO 20022 | GHK101 `@bian:<ServiceDomain>` declared · GHK102 **one** service domain per feature (error) · GHK103 money-moving features cover a duplicated request · GHK104 ISO 20022 / BIAN vocabulary (Debtor, Creditor, Customer Agreement) |
| `telecom` | TM Forum ODA, Open APIs, SID | GHK201 `@tmf:TMFnnn` declared · GHK202 SID vocabulary · GHK203 no UI-level steps (TAC-353 BDD style) |
| `manufacturing` | RAMI 4.0, IDTA AAS, ISA-95, Sparkplug B | GHK301 `@isa95:enterprise/site/area[/line[/cell]]` · GHK302 asset features declare `@aas:<Submodel>` · GHK303 telemetry and ERP–MES transactions are separate scenarios |
| `health` | HL7 FHIR R4/R5, openEHR | GHK401 `@fhir:<Resource>` is a FHIR resource · GHK402 PHI scenarios state consent / authorization (error) · GHK403 synthetic data only (no SSN / e-mail) |
| `supply-chain` | ASCM SCOR-DS, GS1 | GHK501 `@scor:<process>` (OR, P, O, S, T, F, R + number) · GHK502 `@scor-metric:<code>` (e.g. RL.1.1) · GHK503 vocabulary (Supplier, Inventory, Shipment) |
| `insurance` | ACORD Reference Architecture, data standards | GHK601 `@acord:<Capability>` · GHK602 ACORD vocabulary (Policy, Claim, Party) · GHK603 claim features cover denial |
| `aviation` | IATA NDC, ONE Order | GHK701 `@iata:<Message>` · GHK702 no PNR / e-ticket / EMD aggregates · GHK703 orders come from an offer |
| `automotive` | AUTOSAR, ISO 26262, ISO/SAE 21434 | GHK801 `@autosar:adaptive\|backend` (Classic is an error) · GHK802 no hard real-time deadlines (error) · GHK803 no ASIL C/D functions (error) |
| `generic` | — | Common rule only |

Common to all profiles: **GHK090** `@capability:L1/L2/L3/L4` stops at L4. This is the MECE capability decomposition used by BIAN and ACORD.

## Example (banking)

```gherkin
@bian:PaymentExecution @capability:Payments/Execution @aggregate:Transfer
Feature: Transfer funds

  Scenario: Execute a transfer
    Given a debtor with an available balance of 100 EUR
    When the debtor transfers 40 EUR to a creditor ("ExecuteTransferCommand")
    Then the transfer is executed

  Scenario: Duplicated request
    Given an executed transfer
    When the same request is sent twice with the same Idempotency-Key
    Then only one transfer is executed
```
