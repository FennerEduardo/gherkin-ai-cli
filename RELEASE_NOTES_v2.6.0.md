# 🚀 Release Notes: `gherkin-ai` CLI `v2.6.0` (Official Stable Release)

We are thrilled to announce the official release of **`gherkin-ai` v2.6.0**, the Enterprise-Grade Closed-Loop Agentic Orchestration Engine & Spec-Driven Verification Framework for AI Coding Agents.

This release represents a major milestone, closing critical architectural GAPs, expanding full-stack persistence generators, hardening security guardrails, and delivering 100% CI/CD stability.

---

## 🌟 Key Highlights in `v2.6.0`

### 1. Semantic Intermediate Representation (IR Engine)
- **37KB AST & NLP IR Builder (`src/core/ir-builder.ts`):** Extracts rich domain models including Actors, CQRS Commands/Queries, Domain Events, State Machines, Business Invariants, and Endpoints from Gherkin.
- **Traceability Graph:** Links requirements to feature scenarios, DTOs, and test harnesses with automatic coverage metrics.

### 2. Full-Stack Prisma & Zod Scaffolding
- **Auto-Generated `schema.prisma` (`src/generators/prisma-generator.ts`):** Maps IR state machines into Prisma `enum` types and creates relational models with primary UUID keys, timestamps, and unique constraints.
- **Conditional Formatting:** Automatically invokes `npx prisma format` if Prisma is installed locally in the project.
- **Strict Zod DTOs (`src/generators/contracts.ts`):** Infers field validations (`@validate:email`, `@range`) directly into typed Zod schemas.

### 3. Specification Governance, Linter & Convergence
- **Enterprise Constitution (`.gherkin-ai/`):** Centralized architecture rules, agent role permissions (`domain-agent`, `backend-agent`, `qa-agent`), and compliance policies.
- **Specification Linter (`ghk lint`):** Audits Gherkin specs against 14 quality rules with real-time CLI diagnostic feedback.
- **Specification Convergence (`ghk converge`):** Evaluates spec-to-implementation alignment across 6 dimensions.

### 4. Agent Diagnostics & Rollback Logging
- **Attempt Preservation:** When `ghk autopilot` encounters unparseable LLM output, it writes raw prompts, agent responses, and diagnostics to `.gherkin-ai/logs/autopilot/attempt-<task>-<timestamp>.log` before triggering rollbacks.

### 5. Non-Interactive CI/CD Mode & Supply Chain Security
- **Bypass Prompt Locks:** Automatically selects suggested project directories in headless CI environments (`--yes`, `--non-interactive`, `CI=true`).
- **GitHub Actions Generator:** Scaffold CI pipelines (`.github/workflows/gherkin-ai-ci.yml`).
- **npm Provenance:** Built and published with verified npm build provenance.

---

## 📥 Installation

```bash
# Global installation
npm install -g gherkin-ai

# On-demand zero-install
npx -y gherkin-ai <command>

# Local dev dependency
npm install --save-dev gherkin-ai
```

---

## 🧪 Verification & Stability
- **19 Test Files Passed (100%)**
- **217 Unit & Integration Tests Passed (100%)**
- **TypeScript Build (`npx tsc`): 0 errors**
