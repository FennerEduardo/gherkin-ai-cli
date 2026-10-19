# Deploying a generated service

Every generated backend can be deployed as one container image to AWS, GCP, Azure or any Kubernetes cluster. This page covers the image and its runtime contract. Cloud targets (Terraform, Helm) are added in the next 3.2 milestones.

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
| Spring Boot (Java, Kotlin) | `eclipse-temurin:17-jre` | 8080 | `/health` | `/health/ready` (PostgreSQL) |
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
| `AMQP_URL` | for publishing (RabbitMQ) | `amqp://user:password@host:5672`. Without a configured broker, events stay in the outbox |
| `GHK_BROKER` | no | `rabbitmq`, `pubsub` or `servicebus` (see the broker table below for which backends support each). Default: the variables that are set, then `stack.messaging` |
| `PUBSUB_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) | Pub/Sub | GCP project of the topics and subscriptions. The token comes from the workload identity (metadata server) or `GOOGLE_OAUTH_ACCESS_TOKEN` |
| `PUBSUB_EMULATOR_HOST` | no | `host:8085` of the Pub/Sub emulator (local development and tests) |
| `SERVICEBUS_NAMESPACE` | Service Bus | `<name>.servicebus.windows.net`, authenticated with Microsoft Entra ID (managed identity) |
| `SERVICEBUS_CONNECTION_STRING` | Service Bus (alternative) | Shared-access-key connection string. Also used for the emulator (`UseDevelopmentEmulator=true`) |
| `JWT_SECRET` | yes | HS256 secret of bearer tokens. The tenant comes from the token claim only |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | OpenTelemetry collector |

## Event broker per cloud

| Cloud | Broker | Adapter | Notes |
|---|---|---|---|
| AWS | Amazon MQ for RabbitMQ | RabbitMQ (all backends) | Managed RabbitMQ: set `AMQP_URL` to the broker's `amqps://` endpoint. No code change |
| GCP | Pub/Sub | `pubsub` (all backends) | Workload identity token from the metadata server; topics and subscriptions are created if missing |
| Azure | Service Bus (Standard or Premium; topics need Standard+) | `servicebus` (JVM, TypeScript, .NET, Python and Go backends, opt-in) | Generated only with `stack.messaging: "servicebus"`, because it adds the Azure SDK. Uses Entra ID through `SERVICEBUS_NAMESPACE` |
| Azure | Self-managed RabbitMQ or CloudAMQP | RabbitMQ | **Rust, Ruby (Rails), Elixir (Phoenix) and PHP (Laravel)**: there is no official Service Bus SDK for them. Run RabbitMQ on AKS (operator) or use CloudAMQP on Azure, and set `AMQP_URL` |
| Any | Self-managed RabbitMQ (or CloudAMQP) | RabbitMQ | Kubernetes operator or a hosted service |

The adapter is chosen when the service starts: `GHK_BROKER` if set, otherwise the broker whose variables are present, otherwise `stack.messaging`. For every broker, the outbox relay marks a row as published only after the broker has accepted the message. A message that fails in the consumer goes to the dead-letter destination (`<service>.dlx` → `<service>.dlq`) and is not redelivered.
| `GHK_OUTBOX_RELAY` | no | `false` turns off the in-process relay (Spring and Quarkus), e.g. when a separate relay runs |
| `SECRET_KEY_BASE` | Rails, Phoenix | Framework secret |
| `APP_KEY` | Laravel | `base64:<32 bytes>` |
| `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS` | Django | Debug is off in the image; restrict the allowed hosts per environment |

Keep secrets in the platform's secret manager (AWS Secrets Manager, GCP Secret Manager or Azure Key Vault) and inject them as environment variables. The agent firewall requires human approval for changes to `Dockerfile`.

## Verification

`node scripts/golden-build.js <stack>` does four things for each backend:

1. Builds the production image.
2. Starts it next to PostgreSQL and RabbitMQ.
3. Waits until both probes answer 200.
4. Removes everything.

Pass `--no-image` to skip this step.
