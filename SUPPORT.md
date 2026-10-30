# Support

## Getting help

| Need | Where |
|---|---|
| Bug report | [GitHub issue](../../issues/new?template=bug_report.yml) (use the template, and include `ghk --version` and `ghk config show --sources`) |
| Feature request | [GitHub issue](../../issues/new?template=feature_request.yml) |
| Usage question | [GitHub Discussions](../../discussions) |
| Security vulnerability | **Never a public issue.** Follow [SECURITY.md](SECURITY.md) |

Before opening an issue, run the failing command with `--verbose`, and for CI with `--json`. Remove secrets and internal hostnames from what you paste. `ghk auth status` and `ghk config show` never print credentials.

## Versioning

gherkin-ai follows [Semantic Versioning](https://semver.org/).

**Public contract.** Breaking it requires a major version:

- command names, flags and their documented defaults;
- exit codes (`docs/ENTERPRISE.md` §5);
- the `--json` envelope, and the documented JSON fields of `lint`, `converge`, `risk`, `firewall`, `graph`, `audit export` and `config`;
- the configuration schema (`schemas/config.schema.json`): keys are only added in minor versions, and are removed only after a deprecation warning in a previous minor version;
- MCP tool names and their safety level;
- the stable stacks listed by `ghk stacks`. A stack is only demoted from stable in a major version.

**Not part of the public contract:**

- the text of generated code, prompts and human-readable output;
- the exact weights of the risk dimensions, which are documented and may be calibrated in minor versions;
- features marked beta or experimental.

**Generated projects** record the generator version. `ghk upgrade` reports, and on request applies, the changes between versions on a separate branch.

## Release and support policy

| Version | Status | Fixes |
|---|---|---|
| 3.x (latest minor) | Active | bug and security fixes |
| 3.x (previous minor) | Maintenance for 3 months after the next minor | security and critical fixes |
| 2.6.x | Maintenance until 2027-03-31 | critical security fixes only |
| < 2.6 | End of life | none |

Supported environments:

- **Node.js:** 22.19 or later; CI tests 22, 24 and 26.
- **Operating systems:** Linux, macOS and Windows, all tested in CI.
- **Toolchains:** the generated stacks follow the toolchain images listed in `docs/ENTERPRISE.md` §11.

Releases are cut from CI with npm provenance and a CycloneDX SBOM. Each release is described in [CHANGELOG.md](CHANGELOG.md).

## Commercial and organizational use

The package is MIT-licensed and published on npm by the [fenner](https://www.npmjs.com/org/fenner) organization. Documentation: <https://fennereduardo.github.io/gherkin-ai-cli/>. For organization-wide rollout (central configuration, policy locks, providers, proxies, audit), see [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

### Commercial support

The CLI stays MIT, complete, with no paid features. For organizations that need more than community support:

| Offering | What it covers |
|---|---|
| Support agreement | Response times for issues and security questions, help with upgrades between versions |
| Adoption and migration | Rolling gherkin-ai out on existing repositories (governance first, [docs/ADOPTION.md](docs/ADOPTION.md)), migrating 2.x projects |
| Industry profiles | Rules and contract checks for your regulator or standard, built with your team |
| Training | Spec-driven development with AI coding agents, for platform and product teams |

Contact: _pending_. Terms and prices: _pending_. Organizations that sponsor the project or use it in production and agree to be named are listed in the README.
