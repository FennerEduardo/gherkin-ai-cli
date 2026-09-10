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

### Web Studio (Local UI Server)
The `ghk web` command starts a local server that provides a web interface. 
- The server binds strictly to `127.0.0.1` and uses restricted CORS. It is NOT intended to be exposed to a public network.
- The UI contains an endpoint (`/api/execute`) that allows executing CLI commands. While restricted via strict validation, this is inherently a Remote Code Execution (RCE) surface.
- **Do not run `ghk web` in CI/CD or production environments**. It is intentionally disabled by default if `process.env.CI === 'true'`.
