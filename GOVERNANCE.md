# Governance

gherkin-ai is an MIT-licensed project. This page says who decides what, and how someone becomes a maintainer. It exists so that the project does not depend on one person, and so that an organization evaluating it can see that it does not.

## Roles

| Role | Who | Can |
|---|---|---|
| **Contributor** | Anyone who opens an issue, a discussion or a pull request | Propose changes; review others' pull requests |
| **Stack maintainer** | Contributors who keep a *community* stack current (`ghk stacks`, third column) | Approve changes to the generators, goldens and docs of that stack |
| **Maintainer** | Listed in [MAINTAINERS.md](MAINTAINERS.md) | Merge to `main`, triage, cut releases, approve changes to any stack, the public contract and this document |

## How decisions are made

- **Day-to-day changes** are merged by a maintainer after review and a green CI (every golden build included). A maintainer does not merge their own change to the public contract ([SUPPORT.md](SUPPORT.md#versioning)) without a second maintainer's approval once there are two or more.
- **Larger changes** (a new command, a new stack, a change to the automation contract or to the runtime kernel's guarantees) start as a GitHub Discussion with a short proposal: the problem, the change, what it breaks, and how it is verified. They are decided by lazy consensus of the maintainers after at least 7 days; any maintainer may ask for a vote, decided by simple majority.
- **Security reports** follow [SECURITY.md](SECURITY.md) and are handled privately by the maintainers.

## Becoming a maintainer

A contributor becomes a stack maintainer or a maintainer when an existing maintainer nominates them after sustained contributions (typically several merged pull requests and reviews over three months) and no maintainer objects within 7 days. Maintainers who are inactive for six months move to emeritus and can return on request.

## Releases

Releases are cut only by CI from a tag, after the preflight and the release-branch CI run ([CONTRIBUTING.md](CONTRIBUTING.md#releasing)). npm publishing uses provenance; the GitHub release carries a CycloneDX SBOM.

## Continuity

- At least two maintainers hold admin rights on the GitHub repository and owner rights on the npm package (`fenner` organization).
- `main` is protected: pull requests only, required CI checks, no force pushes.
- If the project is moved to a foundation, this document is replaced by the foundation's governance. [docs/FOUNDATION-READINESS.md](docs/FOUNDATION-READINESS.md) tracks what that requires.
