# Release Notes - gherkin-ai v2.6.2

## Architectural Integrity Update

Version 2.6.2 brings critical fixes to the C# / .NET code generation pipelines, ensuring that the scaffolded artifacts are fully compilable, strongly typed, and architecturally sound right out of the box, without producing false stubs.

### Key Highlights

#### 1. Verifiable Architecture (C# / .NET)
- The CLI now emits a fully functional `ApplicationDbContext.cs` and an isolated `Program.cs` for API hosting in C# projects.
- `SpecFlow` has been deprecated in favor of its official successor, `Reqnroll.xUnit`, aligning with modern .NET 8 BDD standards.
- Hardcoded stubs and `Task.CompletedTask` have been replaced with honest, compilable scaffolding blocks indicating exactly where Entity Framework Core integration belongs.

#### 2. Atomic Concurrency (AC-08 & Idempotency)
- We replaced naive in-memory check-then-save Idempotency patterns with an atomic `TryAddAsync` (simulating `INSERT ON CONFLICT`).
- The Transactional Outbox processor now correctly implements the **PostgreSQL `FOR UPDATE SKIP LOCKED`** pattern via `FromSqlRaw`, completely eliminating race conditions when scaling background workers horizontally.

#### 3. Docker-Native Validation Pipeline
- Recognizing that developers and CI/CD pipelines shouldn't need heavy host-level SDKs installed, `ghk generate` now emits a `validate.sh` script for C# environments. This allows instantaneous validation of the scaffolded code using `mcr.microsoft.com/dotnet/sdk:8.0` via a lightweight Docker container.

#### 4. Traceability & Security 
- `docker-compose.yml` generation no longer hardcodes database passwords like `dev_password`. It now properly interpolates shell environment variables (`${POSTGRES_PASSWORD:-dev_password}`).
- `ghk generate` now outputs a `.ghe/suggested_commit.md` containing a generated commit message describing the feature, the artifacts produced, and the validations run, streamlining Git workflows.

### Under the Hood
- Fix: Addressed `CS0111` compilation error caused by duplicate method generation in StepDefinitions when scenarios shared Gherkin steps.
- Fix: Addressed `IRequest` inheritance bounds for MediatR CQRS contracts in C#.
- Fix: Fixed a bug in the AWS CDK generator where project names with hyphens generated invalid TypeScript identifiers.
- Fix: Prevented Zod `contracts.ts` from leaking into non-Node/TypeScript project trees.

Enjoy a cleaner, compilable, and highly robust generated architecture!
