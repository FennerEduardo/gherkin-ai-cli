# Security Policy

## Supported Versions

We take the security of Gherkin-AI very seriously. The following table lists the versions of the CLI that are currently supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 2.6.x   | :white_check_mark: |
| < 2.6.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within Gherkin-AI, please DO NOT report it by creating a public GitHub issue.

Instead, please send an email to our security team at **security@gherkin-ai.com** (or reach out to the repository maintainers directly via private message). 

Please include the following information in your report:
- Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, MCP permission bypass, API key leak).
- Full paths of source file(s) related to the manifestation of the issue.
- The location of the affected source code (tag/branch/commit or direct URL).
- Any special configuration required to reproduce the issue.
- Step-by-step instructions to reproduce the issue.
- Proof of concept or exploit code (if possible).
- Impact of the issue, including how an attacker might exploit the issue.

### Triage and Resolution Process
1. We will acknowledge receipt of your vulnerability report within 48 hours.
2. We will investigate the issue and determine its severity and impact.
3. We will work to provide a patch or mitigation strategy as soon as possible.
4. We will coordinate a public disclosure with you, ensuring you receive proper credit for the discovery (unless you prefer to remain anonymous).

## Automated Security Checks

Gherkin-AI includes a centralized \`AgentPolicyEngine\` and a \`SecuritySanitizer\` to enforce strict filesystem access controls and prevent API key leakage via the MCP protocol. Destructive filesystem operations inherently require explicit human confirmation. If you find a bypass to these internal guardrails, it is considered a critical security vulnerability.
