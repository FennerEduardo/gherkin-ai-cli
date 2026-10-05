# Runtime kernel: the verified persistence, messaging and tracing path

Every generated backend includes a small, framework-neutral runtime next to its domain kernel. It is the code path that `ghk` verifies against real infrastructure: PostgreSQL and RabbitMQ, with OpenTelemetry trace context. Each stack implements it with that language's standard driver, AMQP client and OpenTelemetry SDK. The behavior and the tests are the same in every language.

| Stack(s) | Location | Driver / AMQP / OpenTelemetry | Integration tests |
|---|---|---|---|
| NestJS, Express | `src/runtime/` | `pg`, `amqplib`, `@opentelemetry/*` | `npm run test:integration` |
| ASP.NET Core | `Runtime/` | Npgsql, RabbitMQ.Client, OpenTelemetry .NET | `dotnet test --filter Category=Integration` |
| Spring Boot (Java, Kotlin) | `…/runtime/` | JDBC, amqp-client, OpenTelemetry Java | `mvn verify -Pintegration` / `gradle integrationTest` |
| FastAPI, Django | `app/runtime/` | psycopg 3, pika, opentelemetry-sdk | `pytest -m integration` |
| Go (chi) | `internal/runtime/` | pgx, amqp091-go, otel-go | `go test -tags integration ./...` |
| Laravel | `app/Runtime/` | PDO, php-amqplib, OpenTelemetry PHP | `phpunit --group integration` |
| Rails | `app/runtime/` | pg, bunny, opentelemetry-sdk | `rspec --tag integration` |
| Phoenix | `lib/<app>/runtime/` | Postgrex, AMQP, opentelemetry | `mix test --only integration` |
| Axum | `src/runtime/` | tokio-postgres, lapin, opentelemetry-rust | `cargo test --features integration` |

The integration tests read `DATABASE_URL` (`postgres://user:pass@host:5432/db`) and `AMQP_URL` (`amqp://user:pass@host:5672`). The golden builds start `postgres:17-alpine` and `rabbitmq:4-alpine` for them. To run them locally:

```bash
docker run -d --name ghk-pg -e POSTGRES_PASSWORD=ghk -p 5432:5432 postgres:17-alpine
docker run -d --name ghk-mq -e RABBITMQ_DEFAULT_USER=ghk -e RABBITMQ_DEFAULT_PASS=ghk -p 5672:5672 rabbitmq:4-alpine
export DATABASE_URL=postgres://postgres:ghk@localhost:5432/postgres AMQP_URL=amqp://ghk:ghk@localhost:5672
```

## Schema

All tables live in a configurable PostgreSQL schema. The tests create a fresh schema per test, which keeps them isolated.

```sql
CREATE TABLE ghk_aggregates (tenant_id TEXT, aggregate_type TEXT, id TEXT, state TEXT NOT NULL, version INT NOT NULL,
                             updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, aggregate_type, id));
CREATE TABLE ghk_outbox     (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL,
                             payload TEXT NOT NULL, traceparent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                             claimed_by TEXT, claimed_until TIMESTAMPTZ, published_at TIMESTAMPTZ, attempts INT NOT NULL DEFAULT 0,
                             last_error TEXT, failed_at TIMESTAMPTZ);
CREATE TABLE ghk_idempotency(tenant_id TEXT, key TEXT, status TEXT NOT NULL, response TEXT,
                             created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, key));
CREATE TABLE ghk_inbox      (consumer TEXT, message_id TEXT, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                             PRIMARY KEY (consumer, message_id));
CREATE TABLE ghk_sagas      (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
                             completed_steps TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
```

Every read and write is filtered by `tenant_id`, which is a mandatory argument of each operation. The schema also documents the PostgreSQL row-level-security policy to enable as defense in depth.

## Components and guarantees

1. **Command service** `handle(tenant, aggregateId, command, payload, idempotencyKey?, traceparent?)`. In one transaction it:
   1. claims the idempotency key (`INSERT … ON CONFLICT DO NOTHING`);
   2. loads the aggregate `FOR UPDATE`;
   3. runs the domain command;
   4. saves the new state and version;
   5. inserts the event into the outbox together with the current `traceparent`;
   6. stores the response under the key.

   A domain error rolls everything back, including the key. A replayed key returns the stored response without running the command again (`status: replayed`).
2. **Outbox relay** `publishBatch(workerId, limit)` claims rows with `FOR UPDATE SKIP LOCKED` and a 30 s lease. It publishes each one to the topic exchange `<feature>.events` with publisher confirms, `message_id` = outbox id, and the `traceparent` and `tenant_id` headers, then marks it published. A failed publish releases the lease and records the error. After 5 attempts the row is set aside (`failed_at`).
3. **Inbox consumer** consumes `<feature>.consumer`. It records `message_id` in `ghk_inbox` in the same transaction as the handler, so a redelivered message is acknowledged without running the handler again. A handler error rejects the message without requeue, so RabbitMQ dead-letters it to `<feature>.dlq`.
4. **Saga orchestrator** runs ordered steps. It persists progress after each step. When a step fails, it runs the compensations of the completed steps in reverse order and ends `COMPENSATED`; otherwise it ends `COMPLETED`.
5. **Telemetry.** W3C trace context is propagated from the incoming `traceparent` to:
   - the command span;
   - the outbox row;
   - the published message header;
   - the consumer span.

   The spans are `INTERNAL` (command), `PRODUCER` (publish) and `CONSUMER` (consume), all in the same trace. Exporters are configured with the standard `OTEL_*` environment variables.

## Integration tests (identical in every stack)

| ID | Proves |
|---|---|
| IT1 | A command persists the new aggregate version and exactly one outbox row in one transaction; a domain error persists neither. |
| IT2 | Five concurrent requests with the same idempotency key produce one effect (one outbox row, version 1) and identical responses. |
| IT3 | Two relays running concurrently over 20 pending events publish each event to RabbitMQ exactly once, and every row ends published. |
| IT4 | Tenant B can neither read nor change tenant A's aggregate, even with the same aggregate id. |
| IT5 | When the third saga step fails, the compensations of steps 2 and 1 run in that order and the saga is persisted as `COMPENSATED`. |
| IT6 | A message delivered twice is handled once (inbox), and a message whose handler fails ends in the DLQ. |
| IT7 | With an incoming `traceparent`, the command, publish and consume spans share its trace id. The command span's parent is the incoming span, and the published message carries the trace context. |
