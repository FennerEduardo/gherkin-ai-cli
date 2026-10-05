/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Rust (Axum)
   sqlx + lapin + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface RsRuntimeFile {
  filename: string;
  content: string;
}

const rsStr = (s: string) => JSON.stringify(s);

/** Cargo dependencies of the runtime kernel (appended to [dependencies]). */
export const RS_RUNTIME_DEPS = `futures-util = "0.3"
lapin = "2"
opentelemetry = "0.31"
opentelemetry_sdk = "0.31"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "postgres"] }
uuid = { version = "1", features = ["v4"] }`;

/** Dev-dependencies and the feature that enables tests/runtime_integration.rs. */
export const RS_RUNTIME_DEV_DEPS = `opentelemetry_sdk = { version = "0.31", features = ["testing"] }`;
export const RS_RUNTIME_FEATURES = `[features]
# Runtime integration tests (PostgreSQL + RabbitMQ): cargo test --features integration --test runtime_integration
integration = []`;

export function renderRsRuntime(m: DomainModel, crate: string): RsRuntimeFile[] {
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const first = m.commands[0];

  const mod = `//! Verified persistence, messaging and tracing path (docs/RUNTIME-KERNEL.md).
mod command_service;
mod error;
mod inbox_consumer;
mod outbox_relay;
mod saga;
mod schema;
pub mod telemetry;

pub use command_service::{CommandRequest, CommandResult, CommandService, Snapshot};
pub use error::RuntimeError;
pub use inbox_consumer::{InboxConsumer, Meta};
pub use outbox_relay::{declare_topology, OutboxRelay, Topology};
pub use saga::{SagaOrchestrator, SagaStep};
pub use schema::{migrate, schema_name};
`;

  const error = `use std::fmt;

/// Errors of the runtime kernel. Validation errors are domain or request errors (HTTP 422).
#[derive(Debug)]
pub enum RuntimeError {
    Validation(String),
    Database(sqlx::Error),
    Messaging(lapin::Error),
    Serialization(serde_json::Error),
    Other(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::Validation(m) => write!(f, "validation error: {m}"),
            RuntimeError::Database(e) => write!(f, "database error: {e}"),
            RuntimeError::Messaging(e) => write!(f, "messaging error: {e}"),
            RuntimeError::Serialization(e) => write!(f, "serialization error: {e}"),
            RuntimeError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl From<sqlx::Error> for RuntimeError {
    fn from(e: sqlx::Error) -> Self {
        RuntimeError::Database(e)
    }
}

impl From<lapin::Error> for RuntimeError {
    fn from(e: lapin::Error) -> Self {
        RuntimeError::Messaging(e)
    }
}

impl From<serde_json::Error> for RuntimeError {
    fn from(e: serde_json::Error) -> Self {
        RuntimeError::Serialization(e)
    }
}

impl From<crate::domain::DomainValidationError> for RuntimeError {
    fn from(e: crate::domain::DomainValidationError) -> Self {
        RuntimeError::Validation(e.0)
    }
}
`;

  const schema = `use sqlx::PgPool;

use super::RuntimeError;

const STATEMENTS: &[&str] = &[
${RUNTIME_SCHEMA_SQL.map(s => `    ${rsStr(s)},`).join('\n')}
];

${RLS_NOTE.split('\n').map(l => l.replace(/^-- ?/, '// ')).join('\n')}

/// Validates a PostgreSQL schema identifier (empty means "public").
pub fn schema_name(schema: &str) -> Result<String, RuntimeError> {
    let schema = if schema.is_empty() { "public" } else { schema };
    let mut chars = schema.chars();
    let valid_start = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c == '_');
    if !valid_start || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(RuntimeError::Validation(format!("invalid schema name: {schema}")));
    }
    Ok(schema.to_string())
}

/// Creates the runtime tables (idempotent).
pub async fn migrate(pool: &PgPool, schema: &str) -> Result<(), RuntimeError> {
    let s = schema_name(schema)?;
    for statement in STATEMENTS {
        sqlx::raw_sql(&statement.replace(${rsStr(SCHEMA_TOKEN)}, &s)).execute(pool).await?;
    }
    Ok(())
}
`;

  const telemetry = `//! W3C trace context helpers. Spans go to the globally registered tracer provider
//! (configure an exporter in main, e.g. opentelemetry-otlp with the OTEL_* variables).
use std::collections::HashMap;

use opentelemetry::propagation::TextMapPropagator;
use opentelemetry::trace::{SpanKind, Status, TraceContextExt, Tracer};
use opentelemetry::{global, Context, KeyValue};
use opentelemetry_sdk::propagation::TraceContextPropagator;

/// Returns a context whose parent is the span described by an incoming traceparent.
pub fn context_from(traceparent: Option<&str>) -> Context {
    match traceparent {
        Some(tp) if !tp.is_empty() => {
            let carrier = HashMap::from([("traceparent".to_string(), tp.to_string())]);
            TraceContextPropagator::new().extract(&carrier)
        }
        _ => Context::new(),
    }
}

/// Returns the traceparent header value of a context (None when it carries no span).
pub fn traceparent_of(cx: &Context) -> Option<String> {
    let mut carrier = HashMap::new();
    TraceContextPropagator::new().inject_context(cx, &mut carrier);
    carrier.remove("traceparent")
}

/// Starts a span as a child of \`parent\` and returns the context that carries it.
pub fn start_span(parent: &Context, name: String, kind: SpanKind, attributes: Vec<KeyValue>) -> Context {
    let tracer = global::tracer(${rsStr(m.kebab)});
    let span = tracer.span_builder(name).with_kind(kind).with_attributes(attributes).start_with_context(&tracer, parent);
    parent.with_span(span)
}

/// Ends the span of \`cx\`, marking it as failed when \`error\` is set.
pub fn finish(cx: &Context, error: Option<String>) {
    let span = cx.span();
    if let Some(message) = error {
        span.set_status(Status::error(message));
    }
    span.end();
}
`;

  const commandService = `use std::collections::HashMap;

use opentelemetry::trace::SpanKind;
use opentelemetry::{Context, KeyValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;

use super::{schema_name, telemetry, RuntimeError};
use crate::domain::{${A}, Command, State};

const AGGREGATE_TYPE: &str = ${rsStr(m.pascal)};

#[derive(Debug, Clone, Default)]
pub struct CommandRequest {
    pub tenant_id: String,
    pub aggregate_id: String,
    pub command: String,
    pub payload: HashMap<String, Value>,
    pub idempotency_key: Option<String>,
    /// Incoming W3C trace context (e.g. from the HTTP request).
    pub traceparent: Option<String>,
}

impl CommandRequest {
    pub fn new(tenant_id: impl Into<String>, aggregate_id: impl Into<String>, command: impl Into<String>) -> Self {
        Self { tenant_id: tenant_id.into(), aggregate_id: aggregate_id.into(), command: command.into(), ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub status: String,
    #[serde(rename = "aggregateId")]
    pub aggregate_id: String,
    #[serde(rename = "eventType", default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}

/// An aggregate as stored for a tenant.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub state: String,
    pub version: i32,
}

/// Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE),
/// domain logic, aggregate save and outbox insert. A domain error rolls back everything.
#[derive(Clone)]
pub struct CommandService {
    pool: PgPool,
    s: String,
}

impl CommandService {
    pub fn new(pool: PgPool, schema: &str) -> Result<Self, RuntimeError> {
        Ok(Self { pool, s: schema_name(schema)? })
    }

    pub async fn handle(&self, req: CommandRequest) -> Result<CommandResult, RuntimeError> {
        if req.tenant_id.is_empty() {
            return Err(RuntimeError::Validation("tenant id is required".into()));
        }
        let cx = telemetry::start_span(
            &telemetry::context_from(req.traceparent.as_deref()),
            format!("${m.pascal}.{}", req.command),
            SpanKind::Internal,
            vec![KeyValue::new("tenant.id", req.tenant_id.clone()), KeyValue::new("aggregate.id", req.aggregate_id.clone())],
        );
        let result = self.execute(&cx, &req).await;
        telemetry::finish(&cx, result.as_ref().err().map(|e| e.to_string()));
        result
    }

    async fn execute(&self, cx: &Context, req: &CommandRequest) -> Result<CommandResult, RuntimeError> {
        let s = &self.s;
        let mut tx = self.pool.begin().await?;
        if let Some(key) = &req.idempotency_key {
            let claimed = sqlx::query(&format!("INSERT INTO {s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING"))
                .bind(&req.tenant_id)
                .bind(key)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if claimed == 0 {
                let (status, response): (String, Option<String>) = sqlx::query_as(&format!("SELECT status, response FROM {s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2"))
                    .bind(&req.tenant_id)
                    .bind(key)
                    .fetch_one(&mut *tx)
                    .await?;
                tx.commit().await?;
                if let (true, Some(response)) = (status == "COMPLETED", response) {
                    let mut result: CommandResult = serde_json::from_str(&response)?;
                    result.status = "replayed".into();
                    return Ok(result);
                }
                return Ok(CommandResult { status: "in-progress".into(), aggregate_id: req.aggregate_id.clone(), event_type: None, version: None });
            }
        }

        let stored: Option<(String, i32)> = sqlx::query_as(&format!("SELECT state, version FROM {s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE"))
            .bind(&req.tenant_id)
            .bind(AGGREGATE_TYPE)
            .bind(&req.aggregate_id)
            .fetch_optional(&mut *tx)
            .await?;
        let mut aggregate = match stored {
            None => ${A}::new(req.aggregate_id.clone())?,
            Some((state, version)) => {
                let state = State::parse(&state).ok_or_else(|| RuntimeError::Other(format!("unknown stored state {state}")))?;
                ${A}::restore(req.aggregate_id.clone(), state, version as u64)?
            }
        };
        let command = Command { id: req.aggregate_id.clone(), payload: req.payload.clone() };
        let event = match req.command.as_str() {
${m.commands.map(c => `            ${rsStr(c.snake)} => aggregate.${c.snake}(command)?,`).join('\n')}
            other => return Err(RuntimeError::Validation(format!("unknown command {other}"))),
        };
        sqlx::query(&format!(
            "INSERT INTO {s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) \\
             ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"
        ))
        .bind(&req.tenant_id)
        .bind(AGGREGATE_TYPE)
        .bind(&req.aggregate_id)
        .bind(aggregate.state.as_str())
        .bind(aggregate.version as i32)
        .execute(&mut *tx)
        .await?;
        let payload = json!({ "type": event.event_type.as_str(), "aggregateId": event.aggregate_id, "version": event.version, "payload": event.payload });
        sqlx::query(&format!("INSERT INTO {s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)"))
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&req.tenant_id)
            .bind(&req.aggregate_id)
            .bind(event.event_type.as_str())
            .bind(payload.to_string())
            .bind(telemetry::traceparent_of(cx))
            .execute(&mut *tx)
            .await?;
        let result = CommandResult {
            status: "created".into(),
            aggregate_id: req.aggregate_id.clone(),
            event_type: Some(event.event_type.as_str().to_string()),
            version: Some(event.version),
        };
        if let Some(key) = &req.idempotency_key {
            sqlx::query(&format!("UPDATE {s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2"))
                .bind(&req.tenant_id)
                .bind(key)
                .bind(serde_json::to_string(&result)?)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(result)
    }

    /// Returns the aggregate as \`tenant_id\` sees it (None for other tenants' aggregates).
    pub async fn load(&self, tenant_id: &str, aggregate_id: &str) -> Result<Option<Snapshot>, RuntimeError> {
        let row: Option<(String, i32)> = sqlx::query_as(&format!("SELECT state, version FROM {}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3", self.s))
            .bind(tenant_id)
            .bind(AGGREGATE_TYPE)
            .bind(aggregate_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(state, version)| Snapshot { state, version }))
    }
}
`;

  const relay = `use std::time::Duration;

use lapin::options::{BasicPublishOptions, ConfirmSelectOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, ExchangeKind};
use opentelemetry::trace::SpanKind;
use opentelemetry::KeyValue;
use sqlx::PgPool;

use super::{schema_name, telemetry, RuntimeError};

#[derive(Debug, Clone, PartialEq)]
pub struct Topology {
    pub exchange: String,
    pub queue: String,
    pub dlx: String,
    pub dlq: String,
}

impl Topology {
    /// Topology for a prefix (use one per environment or test).
    pub fn for_prefix(prefix: &str) -> Self {
        Self { exchange: format!("{prefix}.events"), queue: format!("{prefix}.consumer"), dlx: format!("{prefix}.dlx"), dlq: format!("{prefix}.dlq") }
    }
}

impl Default for Topology {
    fn default() -> Self {
        Self { exchange: ${rsStr(t.exchange)}.into(), queue: ${rsStr(t.queue)}.into(), dlx: ${rsStr(t.dlx)}.into(), dlq: ${rsStr(t.dlq)}.into() }
    }
}

fn durable_queue() -> QueueDeclareOptions {
    QueueDeclareOptions { durable: true, ..Default::default() }
}

/// Declares a topic exchange -> consumer queue that dead-letters to a fanout DLX -> DLQ.
pub async fn declare_topology(channel: &Channel, t: &Topology) -> Result<(), RuntimeError> {
    let durable = ExchangeDeclareOptions { durable: true, ..Default::default() };
    channel.exchange_declare(&t.exchange, ExchangeKind::Topic, durable, FieldTable::default()).await?;
    channel.exchange_declare(&t.dlx, ExchangeKind::Fanout, durable, FieldTable::default()).await?;
    channel.queue_declare(&t.dlq, durable_queue(), FieldTable::default()).await?;
    channel.queue_bind(&t.dlq, &t.dlx, "", QueueBindOptions::default(), FieldTable::default()).await?;
    let mut args = FieldTable::default();
    args.insert("x-dead-letter-exchange".into(), AMQPValue::LongString(t.dlx.clone().into()));
    channel.queue_declare(&t.queue, durable_queue(), args).await?;
    channel.queue_bind(&t.queue, &t.exchange, "#", QueueBindOptions::default(), FieldTable::default()).await?;
    Ok(())
}

/// Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
/// concurrent relays never publish the same row; publisher confirms guarantee delivery to the
/// broker before a row is marked published. Use one relay (and channel) per task.
pub struct OutboxRelay {
    pool: PgPool,
    channel: Channel,
    exchange: String,
    s: String,
    pub lease_seconds: f64,
    pub max_attempts: i32,
}

impl OutboxRelay {
    pub async fn new(pool: PgPool, channel: Channel, exchange: &str, schema: &str) -> Result<Self, RuntimeError> {
        let s = schema_name(schema)?;
        channel.confirm_select(ConfirmSelectOptions::default()).await?;
        Ok(Self { pool, channel, exchange: exchange.to_string(), s, lease_seconds: ${LEASE_SECONDS}.0, max_attempts: ${MAX_PUBLISH_ATTEMPTS} })
    }

    pub async fn publish_batch(&self, worker_id: &str, limit: i64) -> Result<usize, RuntimeError> {
        let s = &self.s;
        let claimed: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(&format!(
            "UPDATE {s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1 \\
             WHERE id IN (SELECT id FROM {s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) \\
             ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent"
        ))
        .bind(worker_id)
        .bind(self.lease_seconds)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut published = 0;
        for (id, tenant, event_type, payload, traceparent) in claimed {
            let cx = telemetry::start_span(
                &telemetry::context_from(traceparent.as_deref()),
                format!("{} publish", self.exchange),
                SpanKind::Producer,
                vec![
                    KeyValue::new("messaging.system", "rabbitmq"),
                    KeyValue::new("messaging.destination.name", self.exchange.clone()),
                    KeyValue::new("messaging.message.id", id.clone()),
                    KeyValue::new("tenant.id", tenant.clone()),
                ],
            );
            let mut headers = FieldTable::default();
            headers.insert("tenant_id".into(), AMQPValue::LongString(tenant.into()));
            if let Some(tp) = telemetry::traceparent_of(&cx) {
                headers.insert("traceparent".into(), AMQPValue::LongString(tp.into()));
            }
            let mut outcome = self.publish(&event_type, &id, &payload, headers).await;
            if outcome.is_ok() {
                outcome = sqlx::query(&format!("UPDATE {s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2"))
                    .bind(&id)
                    .bind(worker_id)
                    .execute(&self.pool)
                    .await
                    .map(|_| ())
                    .map_err(RuntimeError::from);
            }
            match outcome {
                Ok(()) => {
                    published += 1;
                    telemetry::finish(&cx, None);
                }
                Err(e) => {
                    let _ = sqlx::query(&format!("UPDATE {s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1"))
                        .bind(&id)
                        .bind(e.to_string())
                        .bind(self.max_attempts)
                        .execute(&self.pool)
                        .await;
                    telemetry::finish(&cx, Some(e.to_string()));
                }
            }
        }
        Ok(published)
    }

    async fn publish(&self, key: &str, id: &str, body: &str, headers: FieldTable) -> Result<(), RuntimeError> {
        let properties = BasicProperties::default()
            .with_message_id(id.into())
            .with_delivery_mode(2)
            .with_content_type("application/json".into())
            .with_type(key.into())
            .with_headers(headers);
        let confirm = self.channel.basic_publish(&self.exchange, key, BasicPublishOptions::default(), body.as_bytes(), properties).await?;
        let confirmation = tokio::time::timeout(Duration::from_secs(10), confirm)
            .await
            .map_err(|_| RuntimeError::Other("publisher confirm timed out".into()))??;
        if confirmation.is_ack() {
            Ok(())
        } else {
            Err(RuntimeError::Other("message was not acknowledged by the broker".into()))
        }
    }
}
`;

  const inbox = `use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use lapin::message::Delivery;
use lapin::options::{BasicAckOptions, BasicCancelOptions, BasicConsumeOptions, BasicNackOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::Channel;
use opentelemetry::trace::SpanKind;
use opentelemetry::KeyValue;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

use super::{schema_name, telemetry, RuntimeError};

/// Describes a delivered message.
#[derive(Debug, Clone)]
pub struct Meta {
    pub message_id: String,
    pub tenant_id: String,
    pub event_type: String,
}

/// Message handler: runs inside the transaction that records the inbox row (\`conn\`).
type Handler = Box<dyn for<'a> Fn(Value, Meta, &'a mut PgConnection) -> BoxFuture<'a, Result<(), String>> + Send + Sync>;

/// Records the message id in ghk_inbox in the same transaction as the handler, so redeliveries
/// are acknowledged without running the handler twice. A handler error rejects the message
/// without requeue, so RabbitMQ dead-letters it to the DLQ.
pub struct InboxConsumer {
    pool: PgPool,
    channel: Channel,
    queue: String,
    name: String,
    handler: Handler,
    s: String,
}

fn header(headers: &Option<FieldTable>, key: &str) -> Option<String> {
    match headers.as_ref()?.inner().get(key)? {
        AMQPValue::LongString(value) => Some(String::from_utf8_lossy(value.as_bytes()).into_owned()),
        AMQPValue::ShortString(value) => Some(value.as_str().to_string()),
        _ => None,
    }
}

impl InboxConsumer {
    pub fn new<F>(pool: PgPool, channel: Channel, queue: &str, name: &str, schema: &str, handler: F) -> Result<Self, RuntimeError>
    where
        F: for<'a> Fn(Value, Meta, &'a mut PgConnection) -> BoxFuture<'a, Result<(), String>> + Send + Sync + 'static,
    {
        Ok(Self { pool, channel, queue: queue.to_string(), name: name.to_string(), handler: Box::new(handler), s: schema_name(schema)? })
    }

    /// Processes messages until the queue stays idle for \`idle\`; returns how many were processed.
    pub async fn drain(&self, idle: Duration) -> Result<usize, RuntimeError> {
        let mut deliveries = self.channel.basic_consume(&self.queue, &self.name, BasicConsumeOptions::default(), FieldTable::default()).await?;
        let mut processed = 0;
        while let Ok(Some(delivery)) = tokio::time::timeout(idle, deliveries.next()).await {
            self.process(delivery?).await;
            processed += 1;
        }
        self.channel.basic_cancel(&self.name, BasicCancelOptions::default()).await?;
        Ok(processed)
    }

    async fn process(&self, delivery: Delivery) {
        let props = &delivery.properties;
        let message_id = props.message_id().as_ref().map(|id| id.as_str().to_string()).unwrap_or_default();
        let meta = Meta {
            message_id: message_id.clone(),
            tenant_id: header(props.headers(), "tenant_id").unwrap_or_default(),
            event_type: props.kind().as_ref().map(|k| k.as_str().to_string()).unwrap_or_default(),
        };
        let cx = telemetry::start_span(
            &telemetry::context_from(header(props.headers(), "traceparent").as_deref()),
            format!("{} process", self.queue),
            SpanKind::Consumer,
            vec![
                KeyValue::new("messaging.system", "rabbitmq"),
                KeyValue::new("messaging.destination.name", self.queue.clone()),
                KeyValue::new("messaging.message.id", message_id),
            ],
        );
        match self.handle(&delivery.data, meta).await {
            Ok(()) => {
                let _ = delivery.ack(BasicAckOptions::default()).await;
                telemetry::finish(&cx, None);
            }
            Err(error) => {
                let _ = delivery.nack(BasicNackOptions { requeue: false, ..Default::default() }).await;
                telemetry::finish(&cx, Some(error));
            }
        }
    }

    async fn handle(&self, body: &[u8], meta: Meta) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;
        let inserted = sqlx::query(&format!("INSERT INTO {}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", self.s))
            .bind(&self.name)
            .bind(&meta.message_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
        if inserted == 1 {
            let event: Value = serde_json::from_slice(body).map_err(|e| format!("invalid message body: {e}"))?;
            (self.handler)(event, meta, &mut *tx).await?;
        }
        tx.commit().await.map_err(|e| e.to_string())
    }
}
`;

  const saga = `use futures_util::future::BoxFuture;
use sqlx::PgPool;

use super::{schema_name, RuntimeError};

type StepFn = Box<dyn Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

pub struct SagaStep {
    pub name: String,
    action: StepFn,
    compensate: StepFn,
}

impl SagaStep {
    pub fn new<A, C>(name: impl Into<String>, action: A, compensate: C) -> Self
    where
        A: Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync + 'static,
        C: Fn() -> BoxFuture<'static, Result<(), String>> + Send + Sync + 'static,
    {
        Self { name: name.into(), action: Box::new(action), compensate: Box::new(compensate) }
    }
}

/// Persists progress after every step; when a step fails, the completed steps are compensated in
/// reverse order. Re-running a saga id resumes after its completed steps.
pub struct SagaOrchestrator {
    pool: PgPool,
    s: String,
}

impl SagaOrchestrator {
    pub fn new(pool: PgPool, schema: &str) -> Result<Self, RuntimeError> {
        Ok(Self { pool, s: schema_name(schema)? })
    }

    pub async fn run(&self, saga_id: &str, tenant_id: &str, steps: &[SagaStep]) -> Result<String, RuntimeError> {
        sqlx::query(&format!("INSERT INTO {}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING", self.s))
            .bind(saga_id)
            .bind(tenant_id)
            .execute(&self.pool)
            .await?;
        let (done,): (String,) = sqlx::query_as(&format!("SELECT completed_steps FROM {}.ghk_sagas WHERE id = $1 AND tenant_id = $2", self.s))
            .bind(saga_id)
            .bind(tenant_id)
            .fetch_one(&self.pool)
            .await?;
        let mut completed: Vec<String> = done.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect();
        for step in steps {
            if completed.contains(&step.name) {
                continue;
            }
            if (step.action)().await.is_err() {
                self.save(saga_id, "COMPENSATING", &completed).await?;
                while let Some(name) = completed.last().cloned() {
                    let done_step = steps.iter().find(|s| s.name == name).ok_or_else(|| RuntimeError::Other(format!("unknown saga step {name}")))?;
                    (done_step.compensate)().await.map_err(RuntimeError::Other)?;
                    completed.pop();
                    self.save(saga_id, "COMPENSATING", &completed).await?;
                }
                self.save(saga_id, "COMPENSATED", &completed).await?;
                return Ok("COMPENSATED".into());
            }
            completed.push(step.name.clone());
            self.save(saga_id, "RUNNING", &completed).await?;
        }
        self.save(saga_id, "COMPLETED", &completed).await?;
        Ok("COMPLETED".into())
    }

    /// Returns the persisted status and completed steps of a saga.
    pub async fn status(&self, saga_id: &str) -> Result<(String, Vec<String>), RuntimeError> {
        let (status, done): (String, String) = sqlx::query_as(&format!("SELECT status, completed_steps FROM {}.ghk_sagas WHERE id = $1", self.s))
            .bind(saga_id)
            .fetch_one(&self.pool)
            .await?;
        Ok((status, done.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect()))
    }

    async fn save(&self, saga_id: &str, status: &str, completed: &[String]) -> Result<(), RuntimeError> {
        sqlx::query(&format!("UPDATE {}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1", self.s))
            .bind(saga_id)
            .bind(status)
            .bind(completed.join(","))
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
`;

  const test = `//! Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
//! Requires DATABASE_URL and AMQP_URL. Run with:
//! cargo test --features integration --test runtime_integration -- --test-threads=1
#![cfg(feature = "integration")]

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use lapin::options::{BasicGetOptions, BasicPublishOptions, QueueDeclareOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties};
use opentelemetry::trace::SpanKind;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use ${crate}::runtime::{declare_topology, migrate, CommandRequest, CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, SagaStep, Topology};

const COMMAND: &str = ${rsStr(first.snake)};
const EVENT: &str = ${rsStr(first.event)};

fn exporter() -> &'static InMemorySpanExporter {
    static EXPORTER: OnceLock<InMemorySpanExporter> = OnceLock::new();
    EXPORTER.get_or_init(|| {
        let exporter = InMemorySpanExporter::default();
        opentelemetry::global::set_tracer_provider(SdkTracerProvider::builder().with_simple_exporter(exporter.clone()).build());
        exporter
    })
}

struct Env {
    pool: PgPool,
    connection: Connection,
    schema: String,
    topology: Topology,
}

impl Env {
    async fn channel(&self) -> Channel {
        self.connection.create_channel().await.expect("channel")
    }

    fn service(&self) -> CommandService {
        CommandService::new(self.pool.clone(), &self.schema).expect("service")
    }

    async fn count(&self, table: &str, condition: &str, arg: Option<&str>) -> i64 {
        let sql = format!("SELECT count(*) FROM {}.{table} WHERE {condition}", self.schema);
        let query = sqlx::query_as::<_, (i64,)>(&sql);
        let query = match arg {
            Some(value) => query.bind(value.to_string()),
            None => query,
        };
        query.fetch_one(&self.pool).await.expect("count").0
    }

    async fn teardown(self) {
        let _ = sqlx::raw_sql(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema)).execute(&self.pool).await;
        let _ = self.connection.close(200, "done").await;
    }
}

fn uid() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

async fn setup() -> Env {
    let db_url = std::env::var("DATABASE_URL").expect("integration tests need DATABASE_URL (see docs/RUNTIME-KERNEL.md)");
    let amqp_url = std::env::var("AMQP_URL").expect("integration tests need AMQP_URL (see docs/RUNTIME-KERNEL.md)");
    exporter().reset();
    let pool = PgPoolOptions::new().max_connections(10).connect(&db_url).await.expect("postgres");
    let connection = Connection::connect(&amqp_url, ConnectionProperties::default()).await.expect("rabbitmq");
    let env = Env { pool, connection, schema: format!("it_{}", uid()), topology: Topology::for_prefix(&format!("it-{}", uid())) };
    migrate(&env.pool, &env.schema).await.expect("migrate");
    env
}

async fn message_count(channel: &Channel, queue: &str) -> u32 {
    let passive = QueueDeclareOptions { passive: true, durable: true, ..Default::default() };
    channel.queue_declare(queue, passive, FieldTable::default()).await.map(|q| q.message_count()).unwrap_or(0)
}

async fn wait_for_messages(channel: &Channel, queue: &str, expected: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while message_count(channel, queue).await != expected {
        assert!(Instant::now() < deadline, "timed out waiting for {expected} message(s) in {queue}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn drain_queue(channel: &Channel, queue: &str) -> Vec<String> {
    let mut ids = Vec::new();
    while let Some(message) = channel.basic_get(queue, BasicGetOptions { no_ack: true }).await.expect("basic_get") {
        ids.push(message.delivery.properties.message_id().as_ref().map(|id| id.as_str().to_string()).unwrap_or_default());
    }
    ids
}

#[tokio::test]
async fn it1_atomic_write_and_rollback() {
    let env = setup().await;
    let service = env.service();
    let result = service.handle(CommandRequest::new("t1", "agg-1", COMMAND)).await.expect("command");
    assert_eq!((result.status.as_str(), result.event_type.as_deref(), result.version), ("created", Some(EVENT), Some(1)));
    assert_eq!(service.load("t1", "agg-1").await.unwrap().map(|s| s.version), Some(1));
    assert_eq!(env.count("ghk_outbox", "aggregate_id = $1", Some("agg-1")).await, 1);

    let mut failing = CommandRequest::new("t1", "agg-2", "no_such_command");
    failing.idempotency_key = Some("k-fail".into());
    let error = service.handle(failing).await.expect_err("unknown command must fail");
    assert!(error.to_string().contains("unknown command"), "{error}");
    assert_eq!(service.load("t1", "agg-2").await.unwrap(), None);
    assert_eq!(env.count("ghk_outbox", "aggregate_id = $1", Some("agg-2")).await, 0);
    assert_eq!(env.count("ghk_idempotency", "key = $1", Some("k-fail")).await, 0);
    env.teardown().await;
}

#[tokio::test]
async fn it2_concurrent_idempotent_requests() {
    let env = setup().await;
    let service = env.service();
    let requests = (0..5).map(|_| {
        let mut request = CommandRequest::new("t1", "agg-1", COMMAND);
        request.idempotency_key = Some("key-1".into());
        service.handle(request)
    });
    let results: Vec<_> = join_all(requests).await.into_iter().map(|r| r.expect("command")).collect();
    assert_eq!(env.count("ghk_outbox", "true", None).await, 1);
    assert_eq!(results.iter().filter(|r| r.status == "created").count(), 1);
    for result in &results {
        assert_eq!((result.event_type.as_deref(), result.version), (Some(EVENT), Some(1)), "divergent response {result:?}");
    }
    env.teardown().await;
}

#[tokio::test]
async fn it3_concurrent_relays_publish_exactly_once() {
    let env = setup().await;
    let service = env.service();
    for i in 0..20 {
        service.handle(CommandRequest::new("t1", format!("agg-{i}"), COMMAND)).await.expect("command");
    }
    let setup_channel = env.channel().await;
    declare_topology(&setup_channel, &env.topology).await.expect("topology");
    let run = |worker: &'static str| {
        let env = &env;
        async move {
            let relay = OutboxRelay::new(env.pool.clone(), env.channel().await, &env.topology.exchange, &env.schema).await.expect("relay");
            let mut total = 0;
            loop {
                let published = relay.publish_batch(worker, 3).await.expect("publish");
                if published == 0 {
                    return total;
                }
                total += published;
            }
        }
    };
    let totals = join_all([run("relay-a"), run("relay-b")]).await;
    assert_eq!(totals.iter().sum::<usize>(), 20, "published {totals:?}");
    assert_eq!(env.count("ghk_outbox", "published_at IS NULL", None).await, 0);
    wait_for_messages(&setup_channel, &env.topology.queue, 20).await;
    let ids: HashSet<String> = drain_queue(&setup_channel, &env.topology.queue).await.into_iter().collect();
    assert_eq!(ids.len(), 20);
    env.teardown().await;
}

#[tokio::test]
async fn it4_tenant_isolation() {
    let env = setup().await;
    let service = env.service();
    service.handle(CommandRequest::new("tenant-a", "shared-id", COMMAND)).await.expect("tenant-a");
    assert_eq!(service.load("tenant-b", "shared-id").await.unwrap(), None);
    service.handle(CommandRequest::new("tenant-b", "shared-id", COMMAND)).await.expect("tenant-b");
    assert_eq!(service.load("tenant-a", "shared-id").await.unwrap().map(|s| s.version), Some(1));
    assert_eq!(service.load("tenant-b", "shared-id").await.unwrap().map(|s| s.version), Some(1));
    assert_eq!(env.count("ghk_outbox", "tenant_id = $1", Some("tenant-a")).await, 1);
    env.teardown().await;
}

#[tokio::test]
async fn it5_saga_compensates_in_reverse_order() {
    let env = setup().await;
    let saga = SagaOrchestrator::new(env.pool.clone(), &env.schema).expect("saga");
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let step = |name: &'static str, fail: bool| {
        let (action_log, undo_log) = (log.clone(), log.clone());
        SagaStep::new(
            name,
            move || {
                let log = action_log.clone();
                Box::pin(async move {
                    if fail {
                        return Err(format!("{name} failed"));
                    }
                    log.lock().unwrap().push(format!("do:{name}"));
                    Ok(())
                })
            },
            move || {
                let log = undo_log.clone();
                Box::pin(async move {
                    log.lock().unwrap().push(format!("undo:{name}"));
                    Ok(())
                })
            },
        )
    };
    let status = saga.run("saga-1", "t1", &[step("reserve", false), step("charge", false), step("ship", true)]).await.expect("saga");
    assert_eq!(status, "COMPENSATED");
    assert_eq!(*log.lock().unwrap(), vec!["do:reserve", "do:charge", "undo:charge", "undo:reserve"]);
    assert_eq!(saga.status("saga-1").await.unwrap(), ("COMPENSATED".to_string(), Vec::<String>::new()));
    let status = saga.run("saga-2", "t1", &[step("reserve", false), step("charge", false)]).await.expect("saga");
    assert_eq!(status, "COMPLETED");
    env.teardown().await;
}

#[tokio::test]
async fn it6_inbox_deduplicates_and_dead_letters() {
    let env = setup().await;
    let channel = env.channel().await;
    declare_topology(&channel, &env.topology).await.expect("topology");
    let handled = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = handled.clone();
    let consumer = InboxConsumer::new(env.pool.clone(), env.channel().await, &env.topology.queue, "it-consumer", &env.schema, move |event, meta, _conn| {
        let seen = seen.clone();
        Box::pin(async move {
            if event["poison"] == true {
                return Err("cannot process".to_string());
            }
            seen.lock().unwrap().push(meta.message_id);
            Ok(())
        })
    })
    .expect("consumer");
    for (id, body) in [("m-1", r#"{"ok": true}"#), ("m-1", r#"{"ok": true}"#), ("m-poison", r#"{"poison": true}"#)] {
        let mut headers = FieldTable::default();
        headers.insert("tenant_id".into(), AMQPValue::LongString("t1".into()));
        let properties = BasicProperties::default().with_message_id(id.into()).with_headers(headers);
        channel.basic_publish(&env.topology.exchange, "Test", BasicPublishOptions::default(), body.as_bytes(), properties).await.expect("publish");
    }
    consumer.drain(Duration::from_secs(1)).await.expect("drain");
    assert_eq!(*handled.lock().unwrap(), vec!["m-1"]);
    assert_eq!(env.count("ghk_inbox", "consumer = $1", Some("it-consumer")).await, 1);
    wait_for_messages(&channel, &env.topology.dlq, 1).await;
    assert_eq!(drain_queue(&channel, &env.topology.dlq).await, vec!["m-poison"]);
    env.teardown().await;
}

#[tokio::test]
async fn it7_trace_context_propagation() {
    let env = setup().await;
    let service = env.service();
    let mut request = CommandRequest::new("t1", "agg-1", COMMAND);
    request.traceparent = Some(${rsStr(TEST_TRACEPARENT)}.into());
    service.handle(request).await.expect("command");
    let (stored,): (Option<String>,) = sqlx::query_as(&format!("SELECT traceparent FROM {}.ghk_outbox", env.schema)).fetch_one(&env.pool).await.unwrap();
    assert!(stored.as_deref().unwrap_or_default().contains(${rsStr(TEST_TRACE_ID)}), "outbox traceparent {stored:?}");

    let channel = env.channel().await;
    declare_topology(&channel, &env.topology).await.expect("topology");
    let relay = OutboxRelay::new(env.pool.clone(), channel, &env.topology.exchange, &env.schema).await.expect("relay");
    assert_eq!(relay.publish_batch("relay", 10).await.expect("publish"), 1);
    let received = Arc::new(Mutex::new(0));
    let counter = received.clone();
    let consumer = InboxConsumer::new(env.pool.clone(), env.channel().await, &env.topology.queue, "trace-consumer", &env.schema, move |_, _, _| {
        *counter.lock().unwrap() += 1;
        Box::pin(async { Ok(()) })
    })
    .expect("consumer");
    consumer.drain(Duration::from_secs(1)).await.expect("drain");
    assert_eq!(*received.lock().unwrap(), 1);

    let spans = exporter().get_finished_spans().expect("spans");
    let by_kind = |kind: SpanKind| spans.iter().find(|s| s.span_kind == kind).unwrap_or_else(|| panic!("no {kind:?} span"));
    let (command, producer, consumer_span) = (by_kind(SpanKind::Internal), by_kind(SpanKind::Producer), by_kind(SpanKind::Consumer));
    for span in [command, producer, consumer_span] {
        assert_eq!(span.span_context.trace_id().to_string(), ${rsStr(TEST_TRACE_ID)}, "{} trace id", span.name);
    }
    assert_eq!(command.parent_span_id.to_string(), ${rsStr(TEST_PARENT_SPAN_ID)});
    assert_eq!(consumer_span.parent_span_id, producer.span_context.span_id());
    env.teardown().await;
}
`;

  return [
    { filename: 'src/runtime/mod.rs', content: mod },
    { filename: 'src/runtime/error.rs', content: error },
    { filename: 'src/runtime/schema.rs', content: schema },
    { filename: 'src/runtime/telemetry.rs', content: telemetry },
    { filename: 'src/runtime/command_service.rs', content: commandService },
    { filename: 'src/runtime/outbox_relay.rs', content: relay },
    { filename: 'src/runtime/inbox_consumer.rs', content: inbox },
    { filename: 'src/runtime/saga.rs', content: saga },
    { filename: 'tests/runtime_integration.rs', content: test }
  ];
}
