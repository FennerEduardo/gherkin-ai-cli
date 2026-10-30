# Industry profiles

gherkin-ai ships eight industry profiles. Each one turns the reference standards of its industry into three things:

- **Lint rules** that `ghk lint` checks on every specification.
- **Constraints** in the semantic model and the generated contracts.
- **Rules for AI agents**, written into every prompt and context file.

A team that writes `@bian:PaymentExecution` on a feature gets a service scoped to one BIAN Service Domain, ISO 20022 vocabulary checked in review, and agents told never to log card numbers. Nobody has to restate any of it in each prompt.

> **Scope.** The compliance entries (PCI DSS, HIPAA, ISO 26262, …) are engineering guidance. They are not legal advice and not a certification. A profile makes the standard visible and checkable during delivery; it does not replace your compliance process.

## The profiles at a glance

| Industry (`industry.id`) | Reference standards | Canonical model | Feature tags | Rules |
|---|---|---|---|---|
| Banking & Financial Services (`banking`) | [BIAN Service Landscape](https://bian.org/servicelandscape/) 12.0, [ISO 20022](https://www.iso20022.org/) | BIAN Service Domains + ISO 20022 Business Model | `@bian`, `@iso20022` | GHK101–GHK104 |
| Telecommunications (`telecom`) | [TM Forum ODA](https://www.tmforum.org/oda/), [TM Forum Open APIs](https://www.tmforum.org/oda/open-apis/), [SID](https://www.tmforum.org/oda/information-systems/information-framework-sid/) | SID entities exposed through TMF Open APIs | `@tmf`, `@oda` | GHK201–GHK203 |
| Manufacturing & Energy (`manufacturing`) | [RAMI 4.0](https://www.plattform-i40.de/), [IDTA Asset Administration Shell](https://industrialdigitaltwin.org/), [ISA-95](https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard), [Sparkplug B](https://sparkplug.eclipse.org/) | ISA-95 equipment hierarchy + AAS submodels | `@isa95`, `@aas` | GHK301–GHK303 |
| Healthcare (`health`) | [HL7 FHIR](https://hl7.org/fhir/) R4 / R5, [openEHR](https://www.openehr.org/) | FHIR resources at the API, openEHR archetypes in the record | `@fhir`, `@openehr` | GHK401–GHK403 |
| Supply Chain & Logistics (`supply-chain`) | [ASCM SCOR-DS](https://www.ascm.org/corporate-solutions/standards-tools/scor-ds/), [GS1](https://www.gs1.org/standards) | SCOR-DS process hierarchy + GS1 identifiers | `@scor`, `@scor-metric` | GHK501–GHK503 |
| Insurance (`insurance`) | [ACORD Reference Architecture](https://www.acord.org/standards-architecture/reference-architecture), [ACORD data standards](https://www.acord.org/standards-architecture/acord-data-standards) | ACORD Capability Model + Information Model | `@acord` | GHK601–GHK603 |
| Aviation & Travel (`aviation`) | [IATA NDC](https://www.iata.org/en/programs/airline-distribution/retailing/ndc/), [IATA ONE Order](https://www.iata.org/en/programs/airline-distribution/retailing/one-order/) | IATA Offer / Order | `@iata` | GHK701–GHK703 |
| Automotive & SDV (`automotive`) | [AUTOSAR](https://www.autosar.org/) Classic & Adaptive, [ISO 26262](https://www.iso.org/standard/68383.html), [ISO/SAE 21434](https://www.iso.org/standard/70918.html) | AUTOSAR Adaptive interfaces + vehicle signal catalog (COVESA VSS) | `@autosar`, `@asil` | GHK801–GHK803 |
| Generic (`generic`) | none | Business capability map of the organization | — | GHK090 only |

Every profile also reads `@capability:<L1>/<L2>[/<L3>[/<L4>]]`. **GHK090** (error) stops the capability tree at L4, the MECE decomposition that BIAN and ACORD use; anything deeper is process detail.

## Turning a profile on

A profile is opt-in, per project:

```json
{ "industry": { "id": "banking", "disabledRules": ["GHK104"] } }
```

```bash
ghk init --industry banking        # new project (also asked interactively; preselects the recommended architecture)
ghk industry apply health          # existing project: sets industry.id and writes .ghe/industry-context.*
ghk industry list                  # every profile
ghk industry show banking --json   # one profile: standards, glossary, rules, agent guidance
```

`industry.id` also accepts aliases: `fintech`, `payments` or `banca` for banking; `telco` or `tmforum` for telecom; `salud`, `fhir` or `ehr` for health; `logistics` or `scor` for supply chain; `insurtech` or `seguros` for insurance; `airline` or `ndc` for aviation; `sdv` or `autosar` for automotive; `industry-4.0` or `energy` for manufacturing. `industry.disabledRules` turns off individual rules; the rest of the profile stays on.

A legacy `domainProfile` such as `"payments"` does **not** turn on an industry. `ghk upgrade` only suggests the matching `ghk industry apply`.

## What a profile changes

| Where | Effect |
|---|---|
| `ghk lint` (and `converge`, MCP `lint_specification`) | The profile rules plus GHK090 run next to the general rules. Errors fail the lint gate |
| Semantic model | One `must` compliance constraint per profile rule, and a governance policy. A profile adds no commands or events |
| `ghk implement` | The master prompt gets an **Industry Standards** section; with `-C` (compact) one paragraph and a pointer to `.ghe/industry-context.md` |
| Agent prompts (`generate`) | Each agent gets `[MANDATORY] Industry Standards`: the profile's rules for agents (listed per profile below) |
| Contracts | OpenAPI and AsyncAPI carry `info.x-industry` (`id`, `standards`, and the classification from the feature tags). The ADR gets an **Industry Standards** section |
| Agent firewall | The profile's sensitive paths require human approval (listed per profile below) |
| `.ghe/industry-context.md` / `.json` | Written by `init`, `generate`, `implement` and `industry apply`. Schema: `schemas/industry-context.schema.json` |
| MCP | Tool `get_industry_profile` (defaults to the project industry) |

Rules read only the parsed specification: tags, scenario names and step text. Quoted example values are ignored unless a rule says otherwise. Keyword lists cover English and Spanish specifications.

### Contract rules

Banking, health and telecom also check what the service exposes: the feature's generated `openapi.json` (else the service-wide one), or the document passed with `--openapi`, so they work on a repository's own contract too. `ghk validate` reports them (an error fails it, exit 4); `ghk converge` takes 15 points per error and 5 per warning from *Architecture Compliance*. `industry.disabledRules` turns any of them off.

| Rule | Industry | Severity | Checks |
|---|---|---|---|
| GHK151 | banking | error | Amount-like properties (`amount`, `balance`, `fee`, `…Amt`) are not `float`/`double` (ISO 20022 amounts are decimals) |
| GHK152 | banking | warning | Every amount has an ISO 4217 `currency` / `ccy` property next to it |
| GHK153 | banking | warning | `iban` and `bic` declare a pattern or format (ISO 13616, ISO 9362) |
| GHK154 | banking | error | No card data (`pan`, `cardNumber`, `cvv`) in requests or responses (PCI DSS) |
| GHK451 | health | warning | A schema named after a FHIR resource (`Patient`, `Observation`, …) has `resourceType` |
| GHK452 | health | error | An operation that carries PHI (`birthDate`, `ssn`, `mrn`, `diagnosis`, …) declares a security requirement (HIPAA) |
| GHK251 | telecom | warning | TM Forum entities (`ProductOrder`, `ServiceOrder`, `Customer`, …) carry `id`, `href` and `@type` (TMF630) |

`ghk industry show <id>` lists them. The contracts gherkin-ai generates pass them (checked on the reference project ts15-quarkus-banking).

---

## Banking & Financial Services (`banking`)

Service-domain decomposition with the BIAN Service Landscape, and ISO 20022 for messages and data.

| Standard | Version | What it governs in the generated service |
|---|---|---|
| BIAN Service Landscape | 12.0 | Bounded contexts: one microservice and one API per Service Domain |
| ISO 20022 Financial Services Messaging | — | Canonical data dictionary and payment / reporting messages (`pacs`, `pain`, `camt`) |

| Rule | Severity | Checks |
|---|---|---|
| GHK101 | warning | The feature declares its BIAN Service Domain: `@bian:PaymentExecution` |
| GHK102 | **error** | One Service Domain per feature: an internal API serves a single domain |
| GHK103 | warning | A feature that moves money (pay, transfer, refund, debit, …) has a scenario for a duplicated request (same Idempotency-Key) |
| GHK104 | info | ISO 20022 / BIAN vocabulary: **Debtor** (not payer, sender), **Creditor** (not payee, receiver), **Customer Agreement** (not contract) |

- **Architecture:** hexagonal, microservices, CQRS, event-driven. Patterns: transactional outbox, saga, idempotency key, inner vs. outer API, audit trail.
- **Compliance reminders:** PCI DSS (card data), SOX (financial reporting controls), PSD2 / Open Banking (strong customer authentication), AML / KYC.
- **Human approval:** `**/payments/**`, `**/ledger/**`, `**/*settlement*`.
- **Agents are told to:**
  - map each feature to exactly one Service Domain;
  - use BIAN service operations (Initiate, Update, Execute, Request, Retrieve, Control, Exchange, Notify) for commands, and the control record as the aggregate;
  - model amounts as decimal plus ISO 4217 currency, never floating point;
  - require an Idempotency-Key on monetary commands and emit their events through the outbox;
  - separate Inner APIs (one domain, canonical model) from Outer APIs (channel orchestration);
  - never persist or log a PAN, CVV or credentials, and mask account identifiers.

```gherkin
@bian:PaymentExecution @iso20022:pacs.008 @capability:Payments/PaymentExecution
@aggregate:PaymentOrder @command:ExecutePayment @event:PaymentExecuted
Feature: Execute a credit transfer
  As a Debtor with a current account
  I want to transfer funds to a Creditor
  So that the payment settles exactly once

  Scenario: Execute an accepted payment
    Given a Debtor account with an available balance of 500 EUR
    When the Debtor executes a payment of 120 EUR to a valid Creditor
    Then the payment is accepted
    And a PaymentExecuted event is published

  Scenario: Duplicated request with the same Idempotency-Key
    Given an executed payment of 120 EUR
    When the same request is sent twice with the same Idempotency-Key
    Then only one movement of 120 EUR exists

  @negative
  Scenario: Payment rejected for insufficient funds
    Given a Debtor account with an available balance of 50 EUR
    When the Debtor executes a payment of 120 EUR to a valid Creditor
    Then the payment is rejected with reason "insufficient funds"
    And no movement exists
    And the rejection is recorded in the audit trail
```

The reference project `ts15-quarkus-banking` is a BIAN Payment Execution service on Quarkus, created with `ghk init --enterprise --industry banking`.

## Telecommunications (`telecom`)

TM Forum Open Digital Architecture: ODA components that expose TM Forum Open APIs over the SID information model.

| Standard | What it governs |
|---|---|
| TM Forum Open Digital Architecture (ODA) | Component boundaries and the ODA Canvas runtime (Kubernetes operators) |
| TM Forum Open APIs | REST contracts per component, e.g. TMF620 catalog, TMF622 ordering, TMF641 service ordering |
| TM Forum Information Framework (SID) | Canonical entities: Party, Customer, Product, Service, Resource |

| Rule | Severity | Checks |
|---|---|---|
| GHK201 | warning | The feature declares the Open API it implements: `@tmf:TMF622` |
| GHK202 | info | SID vocabulary: **Product Offering** (not plan, tariff), **Customer** (not subscriber), **Product Order** (not activation request) |
| GHK203 | warning | Scenarios stay at the business level (TM Forum TAC-353 BDD style): no clicks, buttons, screens or pages |

- **Architecture:** microservices, event-driven, hexagonal. Patterns: TMF Open API contract, event notification hub, saga, transactional outbox.
- **Compliance reminders:** GDPR or local data protection (customer data), lawful interception and data retention, number portability.
- **Human approval:** `**/billing/**`, `**/charging/**`.
- **Agents are told to:**
  - keep resource names and paths aligned with the declared Open API;
  - use SID entity names for aggregates and payloads;
  - publish resource state changes as TMF notification events (e.g. `ProductOrderStateChangeEvent`) through the outbox;
  - package each service as an ODA component, with health probes and its exposed and dependent APIs declared in its manifest.

```gherkin
@tmf:TMF622 @capability:ProductManagement/ProductOrdering
@aggregate:ProductOrder @command:PlaceProductOrder @event:ProductOrderCreated
Feature: Place a product order
  As a Customer
  I want to order a Product Offering
  So that the service is provisioned for my account

  Scenario: Order an available product offering
    Given a Customer with an active account
    And a Product Offering "Fiber 1G" available in the region of the Customer
    When the Customer places a Product Order for the offering
    Then the Product Order is acknowledged
    And a ProductOrderCreated event is published

  @negative
  Scenario: Reject a retired product offering
    Given a Product Offering that is retired
    When the Customer places a Product Order for the offering
    Then the Product Order is rejected with reason "offering not available"
```

## Manufacturing & Energy (`manufacturing`)

Industry 4.0: RAMI 4.0 layering, Asset Administration Shell digital twins, and an ISA-95 Unified Namespace over MQTT Sparkplug B.

| Standard | What it governs |
|---|---|
| Reference Architectural Model Industrie 4.0 (RAMI 4.0) | Layers (asset to business) and hierarchy levels of the system |
| IDTA Asset Administration Shell (AAS) | Digital-twin submodels per asset: nameplate, technical data, operational data |
| ISA-95 Enterprise-Control System Integration | Equipment hierarchy and ERP–MES transactions |
| Eclipse Sparkplug B (MQTT) | Real-time state in the Unified Namespace |

| Rule | Severity | Checks |
|---|---|---|
| GHK301 | warning | The feature declares its ISA-95 path `enterprise/site/area[/line[/cell]]`: `@isa95:acme/plant-a/assembly/line-1` |
| GHK302 | warning | A feature about assets declares the AAS submodel it reads or writes: `@aas:TechnicalData` |
| GHK303 | warning | Real-time telemetry and ERP–MES transactions are separate scenarios |

- **Vocabulary:** **Work Order** (not job ticket), **Equipment** (not device, thing).
- **Architecture:** event-driven, microservices, hexagonal. Patterns: Unified Namespace, digital twin, transactional outbox, idempotent consumer.
- **Compliance reminders:** IEC 62443 (industrial cybersecurity). Functional safety (IEC 61508) stays in the control layer.
- **Human approval:** `**/plc/**`, `**/scada/**`, `**/control/**`.
- **Agents are told to:**
  - identify every asset and event source by its ISA-95 path;
  - model asset information as AAS submodels instead of ad hoc fields;
  - send telemetry through the Unified Namespace (Sparkplug B topics), and work orders, batches and material movements as typed ISA-95 transactions;
  - never command PLCs or SCADA from business services: control actions go through the control layer with human approval;
  - put the asset path and a source timestamp on every event, and make consumers idempotent (telemetry is redelivered).

```gherkin
@isa95:acme/plant-a/assembly/line-1 @aas:OperationalData @capability:Production/WorkOrderExecution
@aggregate:WorkOrder @command:StartWorkOrder @event:WorkOrderStarted
Feature: Start a work order on an assembly line
  As a production supervisor
  I want to start released work orders on a line
  So that production follows the plan from the ERP

  Scenario: Start a released work order
    Given a released Work Order for 200 units on line-1
    And the Equipment on line-1 is idle
    When the supervisor starts the Work Order
    Then the Work Order is in progress
    And a WorkOrderStarted event carries the asset path

  @negative
  Scenario: Reject a work order for busy equipment
    Given the Equipment on line-1 is running another Work Order
    When the supervisor starts the Work Order
    Then the Work Order stays released with reason "equipment busy"
```

## Healthcare (`health`)

The dual model: clinical data persisted as openEHR archetypes, exchanged as HL7 FHIR resources.

| Standard | Version | What it governs |
|---|---|---|
| HL7 FHIR | R4 / R5 | Exchange API: resources, RESTful interactions, SMART on FHIR scopes |
| openEHR | — | Persistence: archetypes and templates for the clinical record |

| Rule | Severity | Checks |
|---|---|---|
| GHK401 | warning | The feature declares the FHIR resource it manages, and it is a real FHIR resource: `@fhir:Patient` |
| GHK402 | **error** | A scenario that handles protected health information (patient, diagnosis, prescription, lab result, …) states the consent or authorization it relies on |
| GHK403 | warning | Synthetic data only: no SSN-like numbers or e-mail addresses in steps, even quoted |

- **Vocabulary:** **Encounter** (not visit), **Practitioner** (not doctor).
- **Architecture:** hexagonal, microservices, event-driven. Patterns: FHIR facade, consent enforcement, audit event, transactional outbox.
- **Compliance reminders:** HIPAA (US), GDPR special-category data (EU) or local health data law, consent and purpose-of-use enforcement, audit of every PHI access (FHIR AuditEvent).
- **Human approval:** `**/phi/**`, `**/patients/**`, `**/consent/**`, `**/clinical/**`.
- **Agents are told to:**
  - expose each capability through its FHIR resource, with standard interactions and status codes;
  - check consent and the caller's SMART on FHIR scopes before every read or write of PHI;
  - record each PHI access as a FHIR AuditEvent / Provenance entry, and never log PHI;
  - persist clinical content as openEHR archetypes: FHIR is the exchange format, not the storage schema;
  - use synthetic test data only.

```gherkin
@fhir:Observation @capability:ClinicalCare/Observations
@aggregate:Observation @command:RecordObservation @event:ObservationRecorded
Feature: Record a vital-sign observation
  As a Practitioner
  I want to record vital signs for a patient
  So that the clinical record stays current

  Scenario: Record an observation with authorization
    Given a Practitioner authorized with the scope "patient/Observation.write"
    And the patient has given consent for treatment
    When the Practitioner records a blood pressure of 120/80 mmHg for patient "SYN-0001"
    Then the observation is stored as a FHIR Observation
    And an AuditEvent records the access

  @negative
  Scenario: Reject a write without authorization
    Given a Practitioner without the scope "patient/Observation.write"
    When the Practitioner records an observation for patient "SYN-0001"
    Then the request is rejected with HTTP 403
```

## Supply Chain & Logistics (`supply-chain`)

The ASCM SCOR Digital Standard: processes (Orchestrate, Plan, Order, Source, Transform, Fulfill, Return) measured by SCOR metrics, with GS1 identifiers.

| Standard | What it governs |
|---|---|
| ASCM SCOR Digital Standard (SCOR-DS) | Process codes and performance metrics: reliability, responsiveness, agility, cost, assets |
| GS1 identification standards | Identifiers for items, locations and logistic units (GTIN, GLN, SSCC) |

| Rule | Severity | Checks |
|---|---|---|
| GHK501 | warning | The feature declares its SCOR-DS process (`OR`, `P`, `O`, `S`, `T`, `F`, `R`, optionally numbered): `@scor:O1` |
| GHK502 | warning | The feature declares the SCOR metric it moves: `@scor-metric:RL.1.1` |
| GHK503 | info | Vocabulary: **Supplier** (not vendor), **Inventory** (not stock), **Shipment** (not dispatch) |

- **Architecture:** event-driven, microservices, CQRS. Patterns: saga, transactional outbox, master data management, event sourcing for traceability.
- **Compliance reminders:** product traceability and recall regulations, customs and trade compliance.
- **Human approval:** `**/master-data/**`.
- **Agents are told to:**
  - identify items, locations and logistic units with GS1 keys instead of internal free-text ids;
  - keep item, supplier and location master data in their own service: transactions reference it and never create it implicitly;
  - emit an event on every order and shipment state change, so the end-to-end flow is traceable;
  - expose the metric the feature moves (e.g. perfect order fulfillment) as an observable measure.

```gherkin
@scor:F1 @scor-metric:RL.1.1 @capability:Fulfillment/OrderFulfillment
@aggregate:Shipment @command:ConfirmShipment @event:ShipmentConfirmed
Feature: Confirm a shipment
  As a warehouse operator
  I want to confirm the Shipment of a picked order
  So that the order is fulfilled on time and in full

  Scenario: Confirm a shipment for a picked order
    Given an order with 3 items identified by GTIN, picked at location GLN "0614141000005"
    When the operator confirms the Shipment with SSCC "106141411234567897"
    Then the Shipment is confirmed
    And a ShipmentConfirmed event is published

  @negative
  Scenario: Reject a shipment with insufficient Inventory
    Given an order whose Inventory at the location is insufficient
    When the operator confirms the Shipment
    Then the Shipment is rejected with reason "insufficient inventory"
```

## Insurance (`insurance`)

The ACORD Reference Architecture: capability model, information model and data standards for policy, billing and claims.

| Standard | What it governs |
|---|---|
| ACORD Reference Architecture | Capability model (bounded contexts) and information model (Party, Policy, Claim) |
| ACORD data standards (P&C, Life) | Message formats for policy, billing and claims exchange |

| Rule | Severity | Checks |
|---|---|---|
| GHK601 | warning | The feature declares its ACORD capability: `@acord:ClaimManagement` |
| GHK602 | info | ACORD vocabulary: **Policy** (not contract), **Claim** (not incident report), **Party** (not client) |
| GHK603 | warning | A claim feature has a denial or rejection scenario |

- **Architecture:** hexagonal, microservices, event-driven. Patterns: saga, transactional outbox, rules engine for underwriting, audit trail.
- **Compliance reminders:** Solvency II or local solvency rules, IFRS 17 (insurance contract reporting), data protection for policyholder data.
- **Human approval:** `**/underwriting/**`, `**/claims/**`, `**/rating/**`.
- **Agents are told to:**
  - keep one ACORD capability per service;
  - use the information model names: Party (in a role), Policy, Coverage, Premium, Claim, Payment;
  - cover approval, denial and referral for claims and underwriting decisions, each with an auditable reason;
  - keep rating and underwriting rules explicit and versioned, and record the rule version behind each decision;
  - make policy changes new versions with effective dates (endorsements), never in-place updates.

```gherkin
@acord:ClaimManagement @capability:Claims/ClaimAdjudication
@aggregate:Claim @command:AdjudicateClaim @event:ClaimAdjudicated
Feature: Adjudicate a claim
  As a claims adjuster
  I want to adjudicate filed claims against the Policy coverage
  So that every decision is consistent and auditable

  Scenario: Approve a covered claim
    Given a Policy in force with a Coverage for water damage
    And a Claim filed by the insured Party for 2000 USD
    When the adjuster adjudicates the Claim
    Then the Claim is approved with reason "covered peril"

  Scenario: Deny a claim outside the coverage
    Given a Policy without flood Coverage
    And a Claim filed for flood damage
    When the adjuster adjudicates the Claim
    Then the Claim is denied with reason "peril not covered"
```

## Aviation & Travel Distribution (`aviation`)

IATA Modern Airline Retailing: NDC offers and ONE Order as the single customer order record, replacing the PNR, the e-ticket and the EMD.

| Standard | What it governs |
|---|---|
| IATA New Distribution Capability (NDC) | Offer and order messages: AirShopping, OfferPrice, OrderCreate, OrderChange |
| IATA ONE Order | A single order record with order items, services and delivery status |

| Rule | Severity | Checks |
|---|---|---|
| GHK701 | warning | The feature declares the NDC / ONE Order message or capability: `@iata:OrderCreate` |
| GHK702 | warning | No PNR, e-ticket or EMD vocabulary: the Order is the record |
| GHK703 | warning | A feature that creates orders says which offer they come from |

- **Vocabulary:** **Order** (not PNR, booking record), **Service Delivery** (not ticket coupon).
- **Architecture:** microservices, event-driven, CQRS. Patterns: offer–order lifecycle, saga, transactional outbox, idempotency key.
- **Compliance reminders:** PCI DSS (payments), passenger data rules (API/PNR data, GDPR), passenger rights (e.g. EU 261/2004).
- **Human approval:** `**/payments/**`, `**/revenue-accounting/**`.
- **Agents are told to:**
  - create an Order only from a priced Offer with an expiry, and reject expired offers;
  - treat the Order and its OrderItems as the single customer record, with no PNR, e-ticket or EMD aggregates;
  - emit an event on every order change and service delivery status (revenue accounting, disruption management);
  - make order changes (reshop, cancel, refund) idempotent operations on the existing order, never a new booking.

```gherkin
@iata:OrderCreate @capability:Retailing/OrderManagement
@aggregate:Order @command:CreateOrder @event:OrderCreated
Feature: Create an order from an offer
  As a traveller
  I want to accept a priced offer
  So that my trip is held in a single order

  Scenario: Create an order from a priced offer
    Given a priced Offer "OF-1" for one passenger that expires in 20 minutes
    When the traveller accepts the Offer
    Then an Order is created with one order item for the flight and one for the bag
    And an OrderCreated event is published

  @negative
  Scenario: Reject an expired offer
    Given a priced Offer that expired 5 minutes ago
    When the traveller accepts the Offer
    Then no Order is created and the request is rejected with reason "offer expired"
```

## Automotive & Software-Defined Vehicles (`automotive`)

AUTOSAR Classic (hard real-time ECUs) and Adaptive (high-performance computers). Generated services target only the vehicle backend or cloud, and Adaptive applications.

| Standard | What it governs |
|---|---|
| AUTOSAR Classic & Adaptive Platform | Service-oriented communication (SOME/IP, `ara::com`) for Adaptive applications |
| ISO 26262 Functional Safety | ASIL levels: safety-relevant functions stay out of generated backend code |
| ISO/SAE 21434 Cybersecurity | Threat analysis and secure update, with UNECE R155 / R156 |

| Rule | Severity | Checks |
|---|---|---|
| GHK801 | **error** | The feature declares `@autosar:adaptive` or `@autosar:backend`. A missing tag is a warning; `@autosar:classic` is an error, because Classic ECU software cannot be generated |
| GHK802 | **error** | No hard real-time deadlines (microseconds, "within 5 ms", "hard real-time") |
| GHK803 | **error** | No ISO 26262 ASIL C or D functions (`@asil:C`, `@asil:D`): generated code is QM, ASIL A or B at most |

- **Vocabulary:** **Vehicle Signal** (not CAN message).
- **Architecture:** event-driven, microservices, hexagonal. Patterns: digital twin, over-the-air update campaign, idempotent consumer, transactional outbox.
- **Compliance reminders:** ISO 26262 (functional safety), ISO/SAE 21434 + UNECE R155 (cybersecurity management), UNECE R156 (software updates).
- **Human approval:** `**/ota/**`, `**/firmware/**`, `**/vehicle-commands/**`.
- **Agents are told to:**
  - target only the backend, the cloud or Adaptive applications;
  - never implement hard real-time behaviour or ASIL C/D functions;
  - use a versioned signal catalog (e.g. COVESA VSS names) with units and types;
  - sign, authorize per vehicle and fully audit remote commands and OTA campaigns (UNECE R155 / R156);
  - treat connectivity as intermittent: commands are idempotent, expire, and report their delivery status.

```gherkin
@autosar:backend @capability:ConnectedVehicle/RemoteCommands
@aggregate:RemoteCommand @command:RequestDoorUnlock @event:DoorUnlockRequested
Feature: Remote door unlock
  As a vehicle owner
  I want to unlock my vehicle remotely
  So that I can let someone in without the key

  Scenario: Unlock a vehicle for its authorized owner
    Given a vehicle "VIN-SYN-0001" linked to an authorized owner
    When the owner requests a remote door unlock that expires in 60 seconds
    Then the unlock command is signed and queued for the vehicle
    And its delivery status is reported when the vehicle connects

  @negative
  Scenario: Expire a command the vehicle never receives
    Given the vehicle is offline
    When the unlock command expires before delivery
    Then the command is reported as expired and is never delivered later
```

## Generic (`generic`)

No reference standard: bounded contexts follow the organization's business capability map. Only GHK090 runs. Agents are told to map each feature to one capability (`@capability:<L1>/<L2>`), use the ubiquitous language of the specification, and treat a capability used by several areas as a shared service.

---

## Notes for teams

- **Every example above passes its profile** with `ghk lint` (3.2.0), and each scores 97–100 overall. The `@negative` tag marks the negative scenarios explicitly; the general rule GHK009 also recognizes them by their outcome (rejected, denied, failed, expired, declined, and the Spanish equivalents).
- **Tags drive the generated names.** The `@aggregate`, `@command` and `@event` tags in the examples name the aggregate, the command route and the events in every Gherkin dialect (`ghk lint --explain-ir` shows the result). Use them in non-English features, where commands cannot be inferred from the steps (GHK016).
- **Start with warnings.** On an existing code base, turn on the profile and run `ghk lint` before gating on it. Fix the errors (GHK102, GHK402, GHK801–803, GHK090) first; they mark a feature that cannot be built safely as specified. See [ADOPTION.md](ADOPTION.md#5-turn-on-the-industry-profile).
- **The rules check specifications, not code.** Whether the code follows the agent rules is shown by review, `ghk converge` and the firewall approvals on the sensitive paths.
