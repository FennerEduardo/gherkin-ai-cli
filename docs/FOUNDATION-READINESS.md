# Foundation readiness

What a neutral home (the [OpenSSF Best Practices badge](https://www.bestpractices.dev/), a CNCF sandbox application, or similar hosting) would check, and where gherkin-ai stands. Each "yes" points to the evidence; each "no" is something to do, and who does it.

Last reviewed: 3.2.2.

## OpenSSF Best Practices (passing level)

| Criterion | Status | Evidence or next step |
|---|---|---|
| Project website, description, how to contribute | yes | README, [CONTRIBUTING.md](../CONTRIBUTING.md), documentation portal (GitHub Pages) |
| FLOSS license, in a standard location | yes | [LICENSE](../LICENSE) (MIT) |
| Documentation of basics and of the interface | yes | [COMMANDS.md](COMMANDS.md), [ENTERPRISE.md](ENTERPRISE.md), JSON Schema of the configuration |
| HTTPS for the project sites | yes | GitHub, npm, GitHub Pages |
| Public discussion, bug reporting process | yes | GitHub issues (templates) and Discussions ([SUPPORT.md](../SUPPORT.md)) |
| Public version control, unique version numbers, release notes | yes | GitHub, SemVer, [CHANGELOG.md](../CHANGELOG.md) |
| Vulnerability reporting process, response time | yes | [SECURITY.md](../SECURITY.md): acknowledgment within 2 business days |
| Working build system, automated test suite, tests for new functionality | yes | CI on Linux, macOS and Windows; unit, contract and golden tests; every stable stack built and tested in its image |
| Compiler warnings / linters | yes | `tsc` strict, actionlint, `terraform fmt`/`validate`, `helm lint` in goldens |
| Secure development knowledge, known vulnerabilities fixed | yes | `npm audit --audit-level=high` blocks CI; dependencies updated per release |
| Static analysis | partial | Type checking and linters run on every change; CodeQL is not enabled yet: maintainer task |
| Dynamic analysis | partial | Security tests of the firewall (48 evasion vectors), sandboxed verification; no fuzzing |
| Signed releases | yes | npm provenance (Sigstore), SBOM on the GitHub release |
| Two-factor authentication for maintainers | to confirm | Maintainer task: require 2FA in the GitHub organization and on npm |
| Bus factor of two or more | **no** | [MAINTAINERS.md](../MAINTAINERS.md): one maintainer. Maintainer task: recruit a second one |

## OpenSSF Scorecard

`.github/workflows/scorecard.yml` runs weekly and on every push to `main`, publishes the results to the Security tab and to the public Scorecard API. Checks that depend on repository settings, not on files:

- **Branch-Protection** and **Code-Review**: protect `main` (pull requests, required reviews, required CI checks) in the repository settings.
- **Maintained**: activity in the last 90 days.
- **Contributors**: contributors from more than one organization.

## Before applying to a foundation

- [ ] A second maintainer with commit and npm rights.
- [ ] Branch protection and 2FA enforced.
- [ ] CodeQL enabled.
- [ ] The Best Practices badge (passing) obtained and linked from the README.
- [ ] At least two organizations that use gherkin-ai and agree to be named.
- [ ] A decision on the trademark and the npm package ownership transfer.
