# Deploying a generated service

Every generated backend can be deployed as one container image to AWS, GCP, Azure or any Kubernetes cluster. This page covers:
- the production image;
- its runtime contract (environment variables and probes);
- the broker for each cloud;
- the deployment code `ghk generate` writes when `deploy` is configured: Terraform for each cloud, and a Helm chart.

## Production image

`ghk generate` writes a `Dockerfile` and a `.dockerignore` next to the backend. Each image:

- **Builds in stages.** It compiles in the same toolchain image the golden builds use, then copies only the result into a smaller runtime image.
- **Runs without root.** The user is UID 10001, or the image's own `node`, `app` or `nonroot` user.
- **Takes configuration only from environment variables.** Nothing environment-specific is baked into the image, so one image runs in dev, staging and prod.
- **Has no `HEALTHCHECK` and no curl.** The platform probes the HTTP paths below.

```bash
docker build -t orders-svc .
docker run -p 8080:8080 -e DATABASE_URL=... -e AMQP_URL=... -e JWT_SECRET=... orders-svc
```

| Stack | Runtime image | Port | Liveness | Readiness |
|---|---|---|---|---|
| NestJS | `node:24-bookworm-slim` | 3000 | `/health` | `/health/ready` (PostgreSQL) |
| Express | `node:24-bookworm-slim` | 3000 | `/health` | `/health` |
| Spring Boot 4 (Java, Kotlin) | `eclipse-temurin:17-jre` | 8080 | `/health` | `/health/ready` (PostgreSQL) |
| Quarkus | `eclipse-temurin:21-jre` | 8080 | `/q/health/live` | `/q/health/ready` (datasource) |
| ASP.NET Core | `mcr.microsoft.com/dotnet/aspnet:8.0` | 8080 | `/health` | `/health` |
| FastAPI | `python:3.12-slim` (uvicorn) | 8000 | `/health` | `/health` |
| Django | `python:3.12-slim` (gunicorn) | 8000 | `/health` | `/health` |
| Go (chi) | `gcr.io/distroless/static-debian12:nonroot` | 8080 | `/health` | `/health` |
| Rust (Axum) | `debian:bookworm-slim` | 3000 | `/health` | `/health` |
| Rails | `ruby:3.3-slim` (Puma) | 3000 | `/health` | `/health` |
| Phoenix | `elixir:1.17` (`mix phx.server`, prod) | 4000 | `/health` | `/health` |
| Laravel | `dunglas/frankenphp:1-php8.3-alpine` | 8000 | `/up` | `/up` |

Where readiness equals liveness, the stack does not yet check its dependencies in the probe.

## Runtime contract

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:password@host:5432/db`. Quarkus maps it to its Agroal pool |
| `AMQP_URL` | for publishing (RabbitMQ) | `amqp://user:password@host:5672`, or `amqps://…:5671` for TLS (Amazon MQ, CloudAMQP). Without a configured broker, events stay in the outbox |
| `GHK_BROKER` | no | `rabbitmq`, `pubsub` or `servicebus` (see the broker table below for which backends support each). Default: the variables that are set, then `stack.messaging` |
| `GHK_DECLARE_TOPOLOGY` | no | `false` skips creating the exchanges, topics and subscriptions at start-up, for when infrastructure as code owns them and the service identity can only publish and consume (the generated Terraform sets it for Pub/Sub and Service Bus) |
| `PUBSUB_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) | Pub/Sub | GCP project of the topics and subscriptions. The token comes from the workload identity (metadata server) or `GOOGLE_OAUTH_ACCESS_TOKEN` |
| `PUBSUB_EMULATOR_HOST` | no | `host:8085` of the Pub/Sub emulator (local development and tests) |
| `SERVICEBUS_NAMESPACE` | Service Bus | `<name>.servicebus.windows.net`, authenticated with Microsoft Entra ID (managed identity; `AZURE_CLIENT_ID` selects a user-assigned identity) |
| `SERVICEBUS_CONNECTION_STRING` | Service Bus (alternative) | Shared-access-key connection string. Also used for the emulator (`UseDevelopmentEmulator=true`) |
| `JWT_SECRET` | yes | HS256 secret of bearer tokens. The tenant comes from the token claim only |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | OpenTelemetry collector (OTLP/HTTP, e.g. `http://localhost:4318`). Set: every backend exports its traces there. Unset: nothing is exported and nothing connects |
| `OTEL_SERVICE_NAME` | no | `service.name` of the exported traces (default: the project name) |
| `GHK_OUTBOX_RELAY` | no | `false` turns off the in-process relay (Spring and Quarkus), e.g. when a separate relay runs |
| `SECRET_KEY_BASE` | Rails, Phoenix | Framework secret |
| `APP_KEY` | Laravel | `base64:<32 bytes>` |
| `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS` | Django | Debug is off in the image; restrict the allowed hosts per environment |

Keep secrets in the platform's secret manager (AWS Secrets Manager, GCP Secret Manager or Azure Key Vault) and inject them as environment variables. The generated Terraform does this for you. The agent firewall requires human approval for changes to `Dockerfile` and `deploy/**`.

## Event broker per cloud

| Cloud | Broker | Adapter | Notes |
|---|---|---|---|
| AWS | Amazon MQ for RabbitMQ | RabbitMQ (all backends) | Managed RabbitMQ: `AMQP_URL` is the broker's `amqps://` endpoint. No code change |
| GCP | Pub/Sub | `pubsub` (all backends) | Workload identity token from the metadata server |
| Azure | Service Bus (Standard or Premium; topics need Standard+) | `servicebus` (JVM, TypeScript, .NET, Python and Go backends, opt-in) | Generated only with `stack.messaging: "servicebus"`, because it adds the Azure SDK. Uses Entra ID through `SERVICEBUS_NAMESPACE` |
| Azure | Self-managed RabbitMQ or CloudAMQP | RabbitMQ | **Rust, Ruby (Rails), Elixir (Phoenix) and PHP (Laravel)**: there is no official Service Bus SDK for them. Run RabbitMQ on AKS (operator) or use CloudAMQP on Azure, and set `AMQP_URL` |
| Any | Self-managed RabbitMQ (or CloudAMQP) | RabbitMQ | Kubernetes operator or a hosted service |
| Any | An existing Kafka cluster: Amazon MSK, Managed Service for Apache Kafka, the Event Hubs Kafka endpoint, Confluent Cloud | `kafka` (JVM, TypeScript, .NET, Python and Go backends, opt-in) | Generated only with `stack.messaging: "kafka"`. `KAFKA_BOOTSTRAP_SERVERS`, plus `KAFKA_SECURITY_PROTOCOL=SASL_SSL`, `KAFKA_SASL_MECHANISM` (PLAIN, or SCRAM-SHA-512 for MSK) and the SASL user and password. Event Hubs: user `$ConnectionString`, password the connection string. The service creates its topics |

The adapter is chosen when the service starts: `GHK_BROKER` if set, otherwise the broker whose variables are present, otherwise `stack.messaging`. For every broker, the outbox relay marks a row as published only after the broker has accepted the message. A message that fails in the consumer goes to the dead-letter destination (`<service>.dlx` → `<service>.dlq`) and is not redelivered.

## Deployment targets (`deploy`)

```json
{
  "deploy": {
    "cloud": "gcp",
    "compute": "containers",
    "environments": ["dev", "staging", "prod"],
    "region": "us-central1"
  }
}
```

- **`cloud`:** `aws`, `gcp` or `azure`.
- **`compute`:**
  - `containers` (the default) is the managed container service, under `deploy/terraform/<cloud>/`;
  - `kubernetes` is a Helm chart under `deploy/helm/<service>/`;
  - `both` writes both.
- **`environments`:** one `.tfvars`, Terraform backend file and Helm values file per environment.

`ghk generate` writes `deploy/README.md` with the exact commands. Only backends with a production image get deployment targets.

| | AWS | Google Cloud | Azure |
|---|---|---|---|
| Containers | ECS Fargate behind an ALB (HTTPS with an ACM certificate), CPU autoscaling, deployment circuit breaker | Cloud Run v2 with Direct VPC egress, startup and liveness probes | Container Apps with a user-assigned identity, liveness and readiness probes |
| Database | RDS for PostgreSQL (encrypted; Multi-AZ, deletion protection and 14-day backups in `prod`) | Cloud SQL for PostgreSQL, private IP (regional and point-in-time recovery in `prod`) | PostgreSQL Flexible Server in a delegated subnet (zone-redundant HA in `prod`) |
| Broker | Amazon MQ for RabbitMQ (AMQPS) | Pub/Sub topics and subscriptions; the service account only publishes and consumes | Service Bus namespace without shared keys (Entra ID data roles), or an external RabbitMQ (`amqp_url` input) |
| Broker with `stack.messaging: "kafka"` | An existing cluster: `kafka_bootstrap_servers`, `kafka_sasl_username` and `kafka_sasl_password` inputs, stored in the secret manager. No Amazon MQ, Pub/Sub or Service Bus | same | same |
| Secrets | Secrets Manager → task secrets | Secret Manager → Cloud Run secret env | Key Vault (RBAC) → Container App secrets |
| Logs | CloudWatch Logs | Cloud Logging | Log Analytics |
| Network (input) | VPC, public and private subnets | VPC network and subnetwork; optional private services access | Container Apps subnet, PostgreSQL delegated subnet and private DNS zone |
| State backend | S3 (`use_lockfile`) | GCS | Azure Storage (Entra ID auth) |

- **Secrets:** `DATABASE_URL`, `JWT_SECRET`, the broker URL and the framework secrets (`SECRET_KEY_BASE`, `APP_KEY`, `DJANGO_SECRET_KEY`) are generated by Terraform and stored in the cloud's secret manager. They also live in the Terraform state, so keep the state backend encrypted and access-controlled.
- **Separate outbox relay:** Django, Laravel and Rails run their outbox relay as a separate process (`manage.py outbox_relay`, `artisan outbox:relay`, `rails outbox:relay`). It is deployed as a second ECS service, a Cloud Run worker pool, a Container App without ingress, or a Helm Deployment.
- **Database TLS:** `db_require_tls` is off by default, and the database is reachable only from the private network. Turn it on once every client of the database connects with TLS.
- **The Helm chart** covers:
  - a Deployment with startup, liveness and readiness probes and a restricted security context (non-root, no privilege escalation, all capabilities dropped, `RuntimeDefault` seccomp);
  - a Service, an HPA, a PodDisruptionBudget and an optional Ingress;
  - a ServiceAccount whose workload-identity annotation (`eks.amazonaws.com/role-arn`, `iam.gke.io/gcp-service-account` or `azure.workload.identity/client-id`) is set in `values-<env>.yaml`.

  Secrets come from an existing Kubernetes Secret, created from the cloud secret manager by External Secrets Operator or the Secrets Store CSI driver. They are never in values files.

## Telemetry

The runtime kernel traces every command, outbox publish and inbox delivery with OpenTelemetry. W3C `traceparent` flows from the HTTP request through the outbox to the consumer; IT7 checks this in every stack.

**Export.** When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the service exports its traces over OTLP/HTTP, batched, with `service.name` from `OTEL_SERVICE_NAME`. Each stack uses its official SDK:

| Stack | Where the export is set up |
|---|---|
| NestJS, Express | `src/runtime/otel.ts` (`NodeTracerProvider`), first thing in `main.ts` / `server.ts` |
| Spring Boot, Quarkus | `infrastructure/telemetry/OpenTelemetryConfig.java` (global `OpenTelemetrySdk`) |
| ASP.NET Core | `AddServiceTelemetry` in `Program.cs` (the runtime's `ActivitySource`, ASP.NET Core and HttpClient instrumentation) |
| FastAPI, Django | `app/runtime/otel.py`, from the FastAPI lifespan / `config/wsgi.py` / `manage.py outbox_relay` |
| Go | `runtime.StartTelemetry` in `main` |
| Rust | `runtime::start_telemetry` in `main` (flushed after a graceful SIGTERM shutdown) |
| Rails | `config/initializers/opentelemetry.rb` |
| Phoenix | `config/config.exs` (`opentelemetry_exporter`) |
| Laravel | `RuntimeServiceProvider::boot` |

**Collector per cloud.** The generated Terraform runs an OpenTelemetry collector as a sidecar and points the service at `http://localhost:4318`. Set `enable_tracing = false` to turn it off.

| Cloud | Collector | Destination | Permission |
|---|---|---|---|
| AWS | AWS Distro for OpenTelemetry (`ecs-default-config.yaml`) | X-Ray (traces), CloudWatch (metrics) | `AWSXRayDaemonWriteAccess`, `CloudWatchAgentServerPolicy` on the task role |
| Google Cloud | Collector contrib, `googlecloud` exporter | Cloud Trace | `roles/cloudtrace.agent` on the service account |
| Azure | Collector contrib, `azuremonitor` exporter | Application Insights (on the Log Analytics workspace) | Connection string as a Container App secret |
| Kubernetes | Your cluster's collector (agent or gateway) | Any | Set `OTEL_EXPORTER_OTLP_ENDPOINT` in `values-<env>.yaml` |

## CI/CD (`ci`)

```json
{ "ci": { "provider": "github" } }
```

The pipeline is written at the repository root, and only when `ci.provider` is set. With `deploy` and no `ci`, the provider defaults to GitHub Actions. The gherkin-ai version is pinned to the one that generated it.

| | GitHub Actions | GitLab CI | Azure Pipelines |
|---|---|---|---|
| Specification gates | `lint`, `validate` (deployment readiness included), `risk --fail-on CRITICAL` on pull requests, `converge` report | same | same |
| Backend | build, tests and the runtime integration suite in the stack's toolchain image, with PostgreSQL and RabbitMQ services | same | same (the toolchain image runs with `docker run`, so Alpine images work) |
| Image | build, Trivy scan of dependencies and image (HIGH/CRITICAL), CycloneDX SBOM | build, push to the project registry on the default branch, Trivy scan and SBOM | build, Trivy scan and SBOM |
| Deployment | one job per environment, in order, gated by GitHub environment protection rules:<br>1. OIDC to the cloud (no static keys);<br>2. push the image to ECR, Artifact Registry or ACR;<br>3. `terraform plan` and `apply`, or `helm upgrade --atomic`;<br>4. smoke test of the readiness probe | run `deploy/` from a protected job with your OIDC federation | run `deploy/` from a deployment job with your workload-identity service connection |

The GitHub workflow header lists the repository variables each environment needs. For example, AWS needs `AWS_ROLE_ARN`, `AWS_REGION` and `ECR_REPOSITORY`; GCP needs `GCP_WORKLOAD_IDENTITY_PROVIDER` and the other GCP variables.

## Context for AI agents

`ghk generate` and `ghk implement` write `.ghe/deployment-context.md` and `.json`. They contain the runtime contract (environment variables, port and probes), the deployment target and its secrets, the rules every change must follow, and a production checklist.

The rules:
- configuration only from the environment;
- no hardcoded hosts or secrets;
- keep the probes working;
- events only through the outbox;
- logs to stdout;
- handle SIGTERM;
- backward-compatible migrations.

The `implement` prompt (compact with `-C`) and the domain and backend agent prompts include a **Deployment Readiness** section.

`ghk validate` checks deployment readiness:
- the Dockerfile exists, runs as non-root, and has no secret in `ENV` or `ARG`;
- `.env.example` documents the variables;
- `deploy/` contains no hardcoded password or key.

The agent firewall requires human approval for `Dockerfile`, `deploy/**`, `*.tf`, `*.tfvars`, `*.tfbackend` and Helm charts.

## Verification

For each backend, `node scripts/golden-build.js <stack>` takes these steps:

1. Builds the production image.
2. Starts it next to PostgreSQL, RabbitMQ and an OpenTelemetry collector.
3. Waits until both probes answer 200.
4. Sends one command with a JWT, expects 202, and requires the collector to receive the service's spans.
5. Removes everything.

Pass `--no-image` to skip this step.

The deployment code is verified without a cloud account:

| Golden | Checks |
|---|---|
| `terraform-aws` | Rails (separate relay): `terraform init -backend=false`, `validate`, `fmt -check` |
| `terraform-gcp` | Laravel (Cloud Run worker pool, `APP_KEY`), same checks |
| `terraform-azure` | NestJS with Service Bus, same checks |
| `terraform-azure-rabbitmq` | Phoenix with an external RabbitMQ, same checks |
| `helm` | Django (relay Deployment): `helm lint --strict`, and `helm template` for every environment |
| `ci-github`, `ci-github-kubernetes` | GitHub Actions with Terraform and with Helm deployment: `actionlint` (with shellcheck) |
| `ci-gitlab`, `ci-azure-pipelines` | The official GitLab CI and Azure Pipelines schemas (`check-jsonschema`) |

CI never runs `terraform apply`.
