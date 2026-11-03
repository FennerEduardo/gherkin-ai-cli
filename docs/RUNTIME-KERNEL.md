# Runtime kernel: the verified persistence, messaging and tracing path

Every generated backend includes a small, framework-neutral runtime next to its domain kernel. It is the code path that `ghk` verifies against real infrastructure: PostgreSQL and an event broker (RabbitMQ, Google Cloud Pub/Sub, Azure Service Bus or Apache Kafka), with OpenTelemetry trace context. Each stack implements it with that language's standard driver, broker client and OpenTelemetry SDK. The behavior and the tests are the same in every language and on every broker.

| Stack(s) | Location | Driver / RabbitMQ client / OpenTelemetry | Integration tests |
|---|---|---|---|
| NestJS, Express | `src/runtime/` | `pg`, `amqplib`, `@opentelemetry/*` | `npm run test:integration` |
| ASP.NET Core | `Runtime/` | Npgsql, RabbitMQ.Client, OpenTelemetry .NET | `dotnet test --filter Category=Integration` |
| Spring Boot (Java, Kotlin), Quarkus (Java, Kotlin) | `…/runtime/` | JDBC (Quarkus: Agroal pool), amqp-client, OpenTelemetry Java | `mvn verify -Pintegration` / `gradle integrationTest` |
| FastAPI, Django | `app/runtime/` | psycopg 3, pika, opentelemetry-sdk | `pytest -m integration` |
| Go (chi) | `internal/runtime/` | pgx, amqp091-go, otel-go | `go test -tags integration ./...` |
| Laravel | `app/Runtime/` | PDO, php-amqplib, OpenTelemetry PHP | `phpunit --group integration` |
| Rails | `app/runtime/` | pg, bunny, opentelemetry-sdk | `rspec --tag integration` |
| Phoenix | `lib/<app>/runtime/` | Postgrex, AMQP, opentelemetry | `mix test --only integration` |
| Axum | `src/runtime/` | sqlx, lapin, opentelemetry-rust | `cargo test --features integration --test runtime_integration --test http_integration` |

## Brokers

The outbox relay and the inbox consumer use broker-neutral ports (publisher, subscription, broker). The adapter is chosen when the service starts: `GHK_BROKER` if set, otherwise the broker whose variables are present, otherwise `stack.messaging`. One image can therefore run on any cloud.

| Broker | Backends | Client | Generated |
|---|---|---|---|
| RabbitMQ (also Amazon MQ, CloudAMQP; `amqps://` for TLS) | all | the client in the table above | always |
| Google Cloud Pub/Sub | all | REST API, no client library (token from the workload identity or `GOOGLE_OAUTH_ACCESS_TOKEN`) | always |
| Azure Service Bus | JVM, TypeScript, .NET, Python, Go | the official Azure SDK, with Microsoft Entra ID (`SERVICEBUS_NAMESPACE`) or a connection string | with `stack.messaging: "servicebus"` |
| Apache Kafka | JVM, TypeScript, .NET, Python, Go | `kafka-clients`, `@confluentinc/kafka-javascript`, `Confluent.Kafka`, `confluent-kafka`, franz-go (no cgo) | with `stack.messaging: "kafka"` |

Rust, Ruby, Elixir and PHP have no official Service Bus or Kafka SDK: with those settings they keep RabbitMQ. On Kafka, the exchange and the DLX are topics, and the queue and the DLQ are consumer groups on them; publishing waits for every in-sync replica (`acks=all`, idempotent producer), and an ack commits the offset. The variables of each broker are in [DEPLOYMENT.md](DEPLOYMENT.md#runtime-contract).

## Running the integration suite

`ghk verify --services` starts PostgreSQL, RabbitMQ and the broker of `stack.messaging` (the Pub/Sub emulator, the Service Bus emulator with its database, or a single-node Kafka, as in the golden builds), runs the stack's integration command in its toolchain image and removes everything. The integration tests read `DATABASE_URL` (`postgres://user:pass@host:5432/db`) and `AMQP_URL` (`amqp://user:pass@host:5672`). The golden builds start `postgres:17-alpine` and `rabbitmq:4-alpine` for them. To run them locally:

```bash
docker run -d --name ghk-pg -e POSTGRES_PASSWORD=ghk -p 5432:5432 postgres:17-alpine
docker run -d --name ghk-mq -e RABBITMQ_DEFAULT_USER=ghk -e RABBITMQ_DEFAULT_PASS=ghk -p 5672:5672 rabbitmq:4-alpine
export DATABASE_URL=postgres://postgres:ghk@localhost:5432/postgres AMQP_URL=amqp://ghk:ghk@localhost:5672
```

## Schema

All tables live in a configurable PostgreSQL schema. The tests create a fresh schema per test, which keeps them isolated.

**The service creates them when it starts**, in `public`, before it serves a request or relays an event: `migrate` runs from the generated startup code of every stack (and from the separate relay process of Django, Laravel and Rails). It is idempotent, and it runs as one statement that first takes a transaction-scoped advisory lock, so replicas starting together do not race on PostgreSQL's catalog. Set `GHK_MIGRATE=false` when a migration job or another tool owns the schema and the service connects without DDL rights; then create the tables below before it starts.

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

1. **Command service** `handle(tenant, aggregateId, command, payload, idempotencyKey?, traceparent?, aggregateType?)`. It holds every aggregate of the service (one per feature whose domain kernel is generated); `aggregateType` selects one and defaults to the feature generated last. In one transaction it:
   1. claims the idempotency key (`INSERT … ON CONFLICT DO NOTHING`);
   2. loads the aggregate `FOR UPDATE`;
   3. runs the domain command;
   4. saves the new state and version;
   5. inserts the event into the outbox together with the current `traceparent`;
   6. stores the response under the key.

   A domain error rolls everything back, including the key. A replayed key returns the stored response without running the command again (`status: replayed`).
2. **Outbox relay** `publishBatch(workerId, limit)` claims rows with `FOR UPDATE SKIP LOCKED` and a 30 s lease. It publishes each one to the topic exchange `<service>.events` (service = `projectName`, shared by every aggregate; routing key = event type) with publisher confirms, `message_id` = outbox id, and the `traceparent` and `tenant_id` headers, then marks it published. A failed publish releases the lease and records the error. After 5 attempts the row is set aside (`failed_at`). On Pub/Sub, Service Bus and Kafka the same names become topics and subscriptions, and the row is marked published only after the broker accepted the message.
3. **Inbox consumer** consumes `<service>.consumer`. It records `message_id` in `ghk_inbox` in the same transaction as the handler, so a redelivered message is acknowledged without running the handler again. A handler error rejects the message without requeue, so RabbitMQ dead-letters it to `<service>.dlq`.
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
| IT3 | Two relays running concurrently over 20 pending events publish each event to the broker exactly once, and every row ends published. |
| IT4 | Tenant B can neither read nor change tenant A's aggregate, even with the same aggregate id. |
| IT5 | When the third saga step fails, the compensations of steps 2 and 1 run in that order and the saga is persisted as `COMPENSATED`. |
| IT6 | A message delivered twice is handled once (inbox), and a message whose handler fails ends in the DLQ. |
| IT7 | With an incoming `traceparent`, the command, publish and consume spans share its trace id. The command span's parent is the incoming span, and the published message carries the trace context. |

## Application layer (wired to the kernel)

Every backend exposes the command service over one HTTP contract:

| Request | Response |
|---|---|
| `POST /api/v1/<feature>/{id}/{command}` with a JSON payload | `202` created, `200` replayed (same `Idempotency-Key`), `409` in progress, `422` domain validation error |
| `Authorization: Bearer <JWT>` (HS256, `JWT_SECRET`) | `401` without a valid token or without the tenant claim (`security.tenantClaim`, default `tenant_id`) |
| `Idempotency-Key`, `traceparent` (optional) | passed to the command service |

The tenant comes only from the validated token. `X-Tenant-Id` is never read and there is no default tenant. An outbox relay worker publishes the outbox every second when a broker is configured (`AMQP_URL`, or the Pub/Sub or Service Bus variables of [DEPLOYMENT.md](DEPLOYMENT.md)). It runs in-process, or as `manage.py outbox_relay` / `artisan outbox:relay` / `rails outbox:relay`.

The generated `openapi.json` (and `contracts/<feature>/openapi.json`) describes exactly this route:
- `command` is an enum of the feature's commands;
- `Idempotency-Key` and `traceparent` are header parameters;
- the responses are `CommandResult` (`status`, `aggregateId`, `eventType`, `version`) and `Error` (`{ "detail": ... }`).

HTTP codes written in the scenarios are not copied into the contract, because the route answers with the codes above.

Each backend has unit tests of this contract with a fake command port, and an HTTP integration test against PostgreSQL. It proves that `X-Tenant-Id` alone gets 401, a command writes one outbox row under the token's tenant, and a replay returns 200. The golden builds generate a two-feature service and run both features' tests.

## Backend-for-frontend (`stack.role: "bff"`)

A backend-for-frontend owns no data and publishes no events, so it gets none of the above: no runtime kernel, database, outbox, aggregate or `seed.sql`, and no `asyncapi.json`. It is generated for Express, NestJS (11 and 12) and Spring Boot.

```json
{
  "stack": { "language": "java", "framework": "spring-boot", "orm": "none", "role": "bff" },
  "bff": {
    "upstreams": {
      "enrollment": { "url": "http://enrollment-service:8080" },
      "academic": { "urlEnv": "ACADEMIC_API_URL" }
    },
    "timeoutMs": 10000
  }
}
```

Each feature names the service that owns its commands with `@upstream:<name>` (the first upstream when it has none). The BFF exposes `POST /bff/v1/<feature>/{id}/{command}` and forwards it to `POST /api/v1/<feature>/{id}/{command}`, the route of the service's application layer above, at the URL in the upstream's environment variable (`ENROLLMENT_URL` by default).

| The BFF | Behaviour |
|---|---|
| Passes on | `Authorization`, `traceparent`, `tracestate`, `Idempotency-Key`, `Accept-Language`; `X-Request-Id` (created when missing, returned to the client) |
| 401 | No bearer token: the call is never forwarded anonymously. The service validates the token |
| 404 | A command the feature does not declare |
| 4xx | The service's answer, as it came |
| 502 | The service answered 5xx (its body is not passed on) or could not be reached |
| 504 | No answer within `bff.timeoutMs` |

`GET /health` answers without calling the services. The generated tests run each of these cases against a stub upstream; the goldens `express-bff`, `nestjs-bff`, `nestjs-12-bff` and `spring-bff` build and run them on every change. `docker-compose.yml` and `.env.example` hold only the BFF and the upstream URLs.

Since 3.3.0, `deploy` and `ci` work for a BFF as for any service, but without data:
- The Terraform module (every cloud, `containers` or `vm`) and the Helm chart have no database, no broker and no outbox relay.
- The URL of each upstream (`bff.upstreams`) is an input per environment (`payments_url` in `environments/<env>.tfvars`), stored in the cloud secret manager.
- The CI pipeline builds, tests and scans the image, without starting PostgreSQL or RabbitMQ and without an integration suite. A BFF has no runtime kernel, and its tests run against a stub upstream.
- The goldens `terraform-aws-bff` (ECS), `terraform-gcp-bff` (a VM), `terraform-azure-bff` (Container Apps) and `helm-bff` validate the output, and check that no database or broker resource is left.

## MySQL (`stack.kernelDatabase: "mysql"`)

The TypeScript kernel (NestJS, Express) and, since 3.3.0, the JVM kernel (Spring Boot and Quarkus, Java and Kotlin) the Python kernel (FastAPI, Django), the .NET kernel (ASP.NET Core) and the Go kernel (chi) also run on MySQL 8.4 when `stack.kernelDatabase` is `"mysql"`. It is a separate key on purpose: until 3.2.1 the kernel ignored `stack.database`, so projects that declare `"mysql"` there run on PostgreSQL, and they keep doing so. Everything above holds, with these differences:

| | PostgreSQL | MySQL |
|---|---|---|
| Driver (TypeScript) | `pg` | `mysql2`, behind `src/runtime/db.ts` (the same `query` / `connect` interface; `$1..$n` placeholders are kept) |
| Driver (JVM) | `org.postgresql:postgresql`, `quarkus-jdbc-postgresql` | `com.mysql:mysql-connector-j`, `quarkus-jdbc-mysql` (Quarkus `db-kind=mysql`); `ConnectionFactory` turns `mysql://` into a `jdbc:mysql://` URL |
| Driver (Python) | `psycopg` 3 | `PyMySQL` (+ `cryptography` for MySQL 8's `caching_sha2_password`), behind `runtime/db.py`: the psycopg call shape the kernel uses (`connect(dsn, autocommit)`, `conn.execute(sql, params)`, commit on a clean `with` exit). The SQLAlchemy engine of FastAPI uses `mysql+pymysql://` |
| Driver (.NET) | `Npgsql` | `MySqlConnector` (`MySqlDataSource`), with `IgnoreCommandTransaction=true` so a command joins its connection's transaction as with Npgsql. Parameters are positional `?`; `CommandService.Exec` keeps `$1..$n` in its statements and binds them in the order they appear |
| Driver (Go) | `pgx` (`pgxpool`) | `database/sql` + `go-sql-driver/mysql`, behind `internal/runtime/db.go`: `runtime.Pool` and `runtime.Tx` keep the pgx calls the kernel uses (`Exec`, `Query`, `QueryRow`, `Begin`, `RowsAffected`, `ErrNoRows`) and bind `$1..$n` as `?` in the order they appear. `runtime.NewPool` replaces `pgxpool.New` |
| Schema | a PostgreSQL schema (default `public`) | a MySQL database (default: the one in `DATABASE_URL`) |
| Migration lock | `pg_advisory_xact_lock` | `GET_LOCK('ghk_runtime_schema')` |
| Idempotency, inbox, saga claims | `INSERT ... ON CONFLICT DO NOTHING` | `INSERT IGNORE` |
| Aggregate save | `ON CONFLICT ... DO UPDATE` | `ON DUPLICATE KEY UPDATE` |
| Outbox claim | one `UPDATE ... RETURNING` over `FOR UPDATE SKIP LOCKED` | `SELECT ... FOR UPDATE SKIP LOCKED`, `UPDATE`, `SELECT` in one transaction |
| Tenant isolation | the repository filter, plus optional row-level security | the repository filter only (MySQL has no row-level security) |
| TLS | `sslmode=require` | `sslmode=require` or `ssl-mode=REQUIRED` in `DATABASE_URL` |

`DATABASE_URL` is `mysql://user:password@host:3306/database`. The service's user needs table privileges in its own database, not global `CREATE`.

On the JVM, the JDBC URL sets `openTelemetry=DISABLED`. Connector/J's own OpenTelemetry hook reads `GlobalOpenTelemetry` when the first connection opens, which is before Spring registers the service's SDK, and that left the service with a no-op tracer: no span reached the collector. The kernel's spans already cover each command, the outbox publish and the inbox.

The goldens `express-mysql`, `nestjs-mysql`, `java-mysql`, `kotlin-mysql`, `quarkus-mysql`, `kotlin-quarkus-mysql`, `fastapi-mysql`, `django-mysql`, `dotnet-mysql` and `go-mysql` run IT1–IT7 and the HTTP suite against MySQL 8.4, then start the production image on a database nothing has touched, send one command and check that its spans reach an OTLP collector. The community stacks (Laravel, Rails, Phoenix, Axum) run their kernel on PostgreSQL only: there, `kernelDatabase: "mysql"` is ignored and the compose file uses PostgreSQL (M-04).

## MongoDB (`stack.kernelDatabase: "mongodb"`)

Since 3.3.0 the TypeScript kernel (NestJS, Express), the Spring Boot kernel (Java), the FastAPI kernel and the .NET kernel also run on MongoDB 8. The command service, outbox relay, inbox, sagas and the IT1–IT7 suite are the same; the guarantees are kept with MongoDB's own tools:

| | PostgreSQL | MongoDB |
|---|---|---|
| Driver (TypeScript) | `pg` | `mongodb` (the official driver), behind `src/runtime/db.ts` (`Pool`, `inTransaction`) |
| Driver (Spring Boot) | JDBC (`org.postgresql`), a `DataSource` shared with JPA | `mongodb-driver-sync` (version managed by Spring Boot), behind `runtime/ConnectionFactory` (same name and `fromUrl`, now one `MongoClient`; `inTransaction`, `ping`). No `DataSource` or JPA: the pom drops `spring-boot-starter-data-jpa`, and `/health/ready` pings MongoDB. The public methods keep `throws SQLException`, so callers compile unchanged |
| Driver (FastAPI) | `psycopg` 3 | `pymongo`, behind `runtime/db.py` (one `MongoClient` per URL, `in_transaction`). The kernel keeps its signatures (`CommandService(dsn, schema)`, `migrate(dsn)`); the inbox handler's `meta` carries `session` and `database`. SQLAlchemy has no MongoDB dialect: `app/database.py` keeps a local SQLite for the generated models |
| Driver (.NET) | `Npgsql` (`NpgsqlDataSource`) | `MongoDB.Driver`: `Connections.FromUrl` returns a `KernelDatabase` (one `MongoClient`, `InTransactionAsync`, `PingAsync`, `Collection`), which the application layer registers where it registered the `NpgsqlDataSource`. The inbox handler's `Meta` carries `Session` and `Database` |
| Schema | a PostgreSQL schema (default `public`) | a database (default: the one in `DATABASE_URL`) |
| Tables | `ghk_aggregates`, `ghk_outbox`, `ghk_idempotency`, `ghk_inbox`, `ghk_sagas` | collections with the same names and fields; unique indexes for the keys |
| Command | one transaction; `FOR UPDATE` on the aggregate | one transaction (snapshot reads, majority writes). A concurrent writer causes a write conflict, and the transaction runs again on the committed data |
| Idempotency | `INSERT ... ON CONFLICT DO NOTHING`, waiting on the unique index | lookup, then insert, in the command's transaction. A concurrent request with the same key conflicts and then replays the stored result |
| Outbox claim | `UPDATE ... RETURNING` over `FOR UPDATE SKIP LOCKED` | one atomic `findOneAndUpdate` per event, with a lease on the server's clock (`$$NOW`) |
| Inbox | `ON CONFLICT DO NOTHING` in the handler's transaction | lookup and insert in the handler's transaction; `MessageMeta` carries its `session` and `db` |
| Tenant isolation | the repository filter, plus optional row-level security | the repository filter only |

Transactions need a replica set. One node is enough: `mongod --replSet rs0`, initiated once. The developer compose file does this: `mongo:8.0`, a healthcheck that initiates the set, `DATABASE_URL=mongodb://mongodb:27017/<db>?replicaSet=rs0`, and `directConnection=true` from the host. Managed services (MongoDB Atlas, Azure Cosmos DB for MongoDB vCore) are replica sets already.

A transaction can run more than once, so an inbox handler should keep its effects in the transaction (`meta.session`). An effect outside it, such as a call to another service, can happen again.

With `stack.orm: "prisma"` (NestJS), the Prisma datasource is MongoDB too, which needs Prisma 6: Prisma 7 does not support MongoDB.

The goldens `express-mongo`, `nestjs-mongo`, `java-mongo`, `fastapi-mongo` and `dotnet-mongo` run IT1–IT7 and the HTTP suite against a MongoDB 8 replica set. They then start the production image on an empty database and check that the spans of one command reach an OTLP collector.
