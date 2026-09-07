# Security Policy

## Supported Versions

Currently, only the latest stable version of Gherkin AI CLI is supported with security updates. 

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within Gherkin AI CLI, please **DO NOT** create a public issue. 

Please send an e-mail to the maintainer or use GitHub Security Advisories to report it privately. All security vulnerabilities will be promptly addressed.

### Features Involving Code Execution
Please note that Gherkin AI CLI has features like `ghk verify --auto-fix` which intentionally modify source code via LLM execution. 
Users are strongly advised to:
1. Always run these features in containerized/Docker environments or inside a CI/CD Sandbox.
2. Use the `--dry-run` flag to review AI-generated code before applying it to the host filesystem.
