# 📖 `gherkin-ai` CLI & Verification Guide (`v2.6.0` Stable)

Comprehensive reference guide for using `gherkin-ai` closed-loop verification, context engineering, quality gates, and multi-agent workflows.

---

## 📥 Installation & Execution Guide (`v2.6.0`)

### 1. Global Installation via `npm`
```bash
npm install -g gherkin-ai
```

### 2. On-Demand Zero-Install via `npx`
```bash
npx -y gherkin-ai <command>
```

### 3. Project Dev Dependency via `npm`
```bash
npm install --save-dev gherkin-ai
```

---

## 📋 Command Summary

| Command | Alias | Description |
| :--- | :--- | :--- |
| `ghk mcp install` | - | Auto-configures MCP server in Cursor and Claude Desktop. |
| `ghk verify` | `v-loop` | Runs test harness with closed-loop verification and auto-fix. |
| `ghk context build` | - | Packages project context and rules into `.ghe/`. |
| `ghk quality` | `q` | Calculates feature quality score and enterprise quality gate. |
| `ghk lint` | - | Runs 14 specification linting rules on Gherkin feature files. |
| `ghk converge` | - | Measures specification-to-code alignment across 6 dimensions. |
| `ghk impact` | - | Calculates blast radius and affected modules of spec changes. |
| `ghk pr-review` | - | Automated PR review bot for spec and architecture compliance. |
| `ghk autopilot` | `auto` | Executes end-to-end multi-agent delivery pipeline. |
| `ghk create` | `c`, `new` | Interactive terminal wizard to write Gherkin specs. |
| `ghk detect` | `d` | Auto-detects tech stack and architecture in workspace. |
| `ghk generate` | `g` | Generates contracts, DTOs, fixtures, and agent prompt packages. |

---

## 🔁 Closed-Loop Verification (`ghk verify`)

```bash
# Run verification with automatic agent self-healing loop
ghk verify --auto-fix

# Run inside an isolated Docker sandbox container
ghk verify --auto-fix --docker

# Custom retry limit
ghk verify --auto-fix --max-retries 5
```

---

## 📦 Context Engineering (`ghk context`)

```bash
# Generate .ghe/ directory with architecture, conventions, and security policies
ghk context build
```

---

## 📊 Quality Score Index (`ghk quality`)

```bash
ghk quality
```

Evaluates quality dimensions and enforces quality gate before merge.
