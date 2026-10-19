/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Rust (Axum)
   sqlx + lapin + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor } from './jvm';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface RsRuntimeFile {
  filename: string;
  content: string;
}

const rsStr = (s: string) => JSON.stringify(s);

/** Cargo dependencies of the runtime kernel (appended to [dependencies]). */
export const RS_RUNTIME_DEPS = `futures-util = "0.3"
lapin = "2"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
opentelemetry = "0.33"
opentelemetry_sdk = "0.33"
opentelemetry-otlp = { version = "0.33", default-features = false, features = ["trace", "http-proto", "reqwest-blocking-client", "reqwest-rustls"] }
sqlx ={ version = "0.8", default-features = false, features = ["runtime-tokio", "postgres"] }
uuid = { version = "1", features = ["v4"] }`;

/** Dev-dependencies and the feature that enables tests/runtime_integration.rs. */
export const RS_RUNTIME_DEV_DEPS = `opentelemetry_sdk = { version = "0.33", features = ["testing"] }`;
export const RS_RUNTIME_FEATURES = `[features]
# Runtime integration tests (PostgreSQL + RabbitMQ): cargo test --features integration --test runtime_integration
integration = []`;

export function renderRsRuntime(m: DomainModel, crate: string, siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): RsRuntimeFile[] {
  // Service Bus has no official Rust SDK: stack.messaging "servicebus" keeps RabbitMQ as the default broker.
  const defaultBroker = defaultBrokerFor(messaging) === 'pubsub' ? 'pubsub' : 'rabbitmq';
  const all = [m, ...siblings];
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const first = m.commands[0];

  const mod = `//! Verified persistence, messaging and tracing path (docs/RUNTIME-KERNEL.md).
mod broker;
mod command_service;
mod error;
mod inbox_consumer;
mod outbox_relay;
mod saga;
mod otel;
mod schema;
pub mod telemetry;

pub use otel::start_telemetry;
pub use command_service::{CommandRequest, CommandResult, CommandService, Snapshot};
pub use error::RuntimeError;
pub use inbox_consumer::{InboxConsumer, Meta};
pub use broker::{broker_configured, broker_kind, Broker, BrokerMessage, Delivery, EventPublisher, EventSubscription, PubSubBroker, Topology, DEFAULT_BROKER};
pub use outbox_relay::OutboxRelay;
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

${all.map(a => `impl From<crate::domain::${a.snake}::DomainValidationError> for RuntimeError {
    fn from(e: crate::domain::${a.snake}::DomainValidationError) -> Self {
        RuntimeError::Validation(e.0)
    }
}`).join('\n\n')}
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


/// Aggregate type used when a request does not name one.
pub const DEFAULT_AGGREGATE: &str = ${rsStr(m.pascal)};

/// An aggregate's new state after a command, and the recorded event.
struct Applied {
    state: String,
    version: i32,
    event_type: String,
    event_version: u64,
    payload: Value,
}
${all.map(a => `
fn apply_${a.snake}(stored: Option<(String, i32)>, id: &str, command: &str, payload: HashMap<String, Value>) -> Result<Applied, RuntimeError> {
    use crate::domain::${a.snake}::{${a.pascal}Aggregate, Command, State};
    let mut aggregate = match stored {
        None => ${a.pascal}Aggregate::new(id)?,
        Some((state, version)) => {
            let state = State::parse(&state).ok_or_else(|| RuntimeError::Other(format!("unknown stored state {state}")))?;
            ${a.pascal}Aggregate::restore(id, state, version as u64)?
        }
    };
    let command_value = Command { id: id.to_string(), payload };
    let event = match command {
${a.commands.map(c => `        ${rsStr(c.snake)} => aggregate.${c.snake}(command_value)?,`).join('\n')}
        other => return Err(RuntimeError::Validation(format!("unknown command {other}"))),
    };
    Ok(Applied {
        state: aggregate.state.as_str().to_string(),
        version: aggregate.version as i32,
        event_type: event.event_type.as_str().to_string(),
        event_version: event.version,
        payload: json!({ "type": event.event_type.as_str(), "aggregateId": event.aggregate_id, "version": event.version, "payload": event.payload }),
    })
}`).join('\n')}

#[derive(Debug, Clone, Default)]
pub struct CommandRequest {
    pub tenant_id: String,
    /// The feature's aggregate (e.g. ${rsStr(m.pascal)}); None means DEFAULT_AGGREGATE.
    pub aggregate_type: Option<String>,
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

        let aggregate_type = req.aggregate_type.clone().unwrap_or_else(|| DEFAULT_AGGREGATE.to_string());
        let stored: Option<(String, i32)> = sqlx::query_as(&format!("SELECT state, version FROM {s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE"))
            .bind(&req.tenant_id)
            .bind(&aggregate_type)
            .bind(&req.aggregate_id)
            .fetch_optional(&mut *tx)
            .await?;
        let applied = match aggregate_type.as_str() {
${all.map(a => `            ${rsStr(a.pascal)} => apply_${a.snake}(stored, &req.aggregate_id, &req.command, req.payload.clone())?,`).join('\n')}
            other => return Err(RuntimeError::Validation(format!("unknown aggregate type {other}"))),
        };
        sqlx::query(&format!(
            "INSERT INTO {s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) \\
             ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"
        ))
        .bind(&req.tenant_id)
        .bind(&aggregate_type)
        .bind(&req.aggregate_id)
        .bind(&applied.state)
        .bind(applied.version)
        .execute(&mut *tx)
        .await?;
        sqlx::query(&format!("INSERT INTO {s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)"))
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&req.tenant_id)
            .bind(&req.aggregate_id)
            .bind(&applied.event_type)
            .bind(applied.payload.to_string())
            .bind(telemetry::traceparent_of(cx))
            .execute(&mut *tx)
            .await?;
        let result = CommandResult {
            status: "created".into(),
            aggregate_id: req.aggregate_id.clone(),
            event_type: Some(applied.event_type.clone()),
            version: Some(applied.event_version),
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
        self.load_type(DEFAULT_AGGREGATE, tenant_id, aggregate_id).await
    }

    /// load for a given aggregate type.
    pub async fn load_type(&self, aggregate_type: &str, tenant_id: &str, aggregate_id: &str) -> Result<Option<Snapshot>, RuntimeError> {
        let row: Option<(String, i32)> = sqlx::query_as(&format!("SELECT state, version FROM {}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3", self.s))
            .bind(tenant_id)
            .bind(aggregate_type)
            .bind(aggregate_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(state, version)| Snapshot { state, version }))
    }
}
`;

  const broker = `//! The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on
//! any cloud: GHK_BROKER=rabbitmq (AMQP_URL) or pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT;
//! PUBSUB_EMULATOR_HOST). Without GHK_BROKER the configured variables decide, then stack.messaging.
//! Azure Service Bus has no official Rust SDK: on Azure use self-managed RabbitMQ or CloudAMQP (AMQP_URL).
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use lapin::message::Delivery as AmqpDelivery;
use lapin::options::{BasicAckOptions, BasicGetOptions, BasicNackOptions, BasicPublishOptions, ConfirmSelectOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions};
use lapin::types::{AMQPValue, FieldTable};
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties, ExchangeKind};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::RuntimeError;

/// Publish to \`exchange\` (topic), consume from \`queue\` (subscription); dead letters go to \`dlx\`, read from \`dlq\`.
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

/// Broker of the generated configuration (stack.messaging).
pub const DEFAULT_BROKER: &str = ${rsStr(defaultBroker)};

/// A domain event on the wire, independent of the broker.
#[derive(Debug, Clone)]
pub struct BrokerMessage {
    pub message_id: String,
    pub event_type: Option<String>,
    pub tenant_id: Option<String>,
    pub traceparent: Option<String>,
    pub body: Vec<u8>,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// GHK_BROKER, else the broker whose variables are set, else DEFAULT_BROKER.
pub fn broker_kind() -> String {
    if let Some(kind) = env("GHK_BROKER") {
        return kind.trim().to_lowercase();
    }
    if env("AMQP_URL").is_some() {
        return "rabbitmq".into();
    }
    if env("PUBSUB_PROJECT_ID").is_some() || env("PUBSUB_EMULATOR_HOST").is_some() {
        return "pubsub".into();
    }
    DEFAULT_BROKER.into()
}

/// Whether the variables of the selected broker are set.
pub fn broker_configured() -> bool {
    match broker_kind().as_str() {
        "pubsub" => env("PUBSUB_PROJECT_ID").is_some() || env("GOOGLE_CLOUD_PROJECT").is_some(),
        _ => env("AMQP_URL").is_some(),
    }
}

/// The event broker (enum dispatch keeps the adapters free of async traits).
pub enum Broker {
    RabbitMq(Connection),
    PubSub(PubSubBroker),
}

impl Broker {
    pub async fn connect() -> Result<Self, RuntimeError> {
        match broker_kind().as_str() {
            "rabbitmq" => {
                let url = env("AMQP_URL").ok_or_else(|| RuntimeError::Other("AMQP_URL is not set (amqp://user:password@host:5672)".into()))?;
                // A busy host can delay the AMQP handshake: retry before failing.
                let mut attempt = 1;
                loop {
                    match Connection::connect(&url, ConnectionProperties::default()).await {
                        Ok(connection) => return Ok(Broker::RabbitMq(connection)),
                        Err(e) if attempt == 5 => return Err(e.into()),
                        Err(_) => {
                            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
                            attempt += 1;
                        }
                    }
                }
            }
            "pubsub" => Ok(Broker::PubSub(PubSubBroker::from_env()?)),
            "servicebus" => Err(RuntimeError::Other("Azure Service Bus has no official Rust SDK: use RabbitMQ (self-managed or CloudAMQP) on Azure".into())),
            kind => Err(RuntimeError::Other(format!("unsupported GHK_BROKER: {kind} (rabbitmq, pubsub)"))),
        }
    }

    pub fn system(&self) -> &'static str {
        match self {
            Broker::RabbitMq(_) => "rabbitmq",
            Broker::PubSub(_) => "gcp_pubsub",
        }
    }

    /// Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code.
    pub async fn declare(&self, t: &Topology) -> Result<(), RuntimeError> {
        match self {
            Broker::RabbitMq(connection) => {
                let channel = connection.create_channel().await?;
                let durable = ExchangeDeclareOptions { durable: true, ..Default::default() };
                let queue = QueueDeclareOptions { durable: true, ..Default::default() };
                channel.exchange_declare(&t.exchange, ExchangeKind::Topic, durable, FieldTable::default()).await?;
                channel.exchange_declare(&t.dlx, ExchangeKind::Fanout, durable, FieldTable::default()).await?;
                channel.queue_declare(&t.dlq, queue, FieldTable::default()).await?;
                channel.queue_bind(&t.dlq, &t.dlx, "", QueueBindOptions::default(), FieldTable::default()).await?;
                let mut args = FieldTable::default();
                args.insert("x-dead-letter-exchange".into(), AMQPValue::LongString(t.dlx.clone().into()));
                channel.queue_declare(&t.queue, queue, args).await?;
                channel.queue_bind(&t.queue, &t.exchange, "#", QueueBindOptions::default(), FieldTable::default()).await?;
                let _ = channel.close(200, "declared").await;
                Ok(())
            }
            Broker::PubSub(pubsub) => pubsub.declare(t).await,
        }
    }

    pub async fn publisher(&self, destination: &str) -> Result<EventPublisher, RuntimeError> {
        match self {
            Broker::RabbitMq(connection) => {
                let channel = connection.create_channel().await?;
                channel.confirm_select(ConfirmSelectOptions::default()).await?;
                Ok(EventPublisher::RabbitMq { channel, exchange: destination.to_string() })
            }
            Broker::PubSub(pubsub) => Ok(EventPublisher::PubSub { broker: pubsub.clone(), topic: destination.to_string() }),
        }
    }

    /// \`t\` says where dead-lettered messages go.
    pub async fn subscribe(&self, source: &str, t: &Topology) -> Result<EventSubscription, RuntimeError> {
        match self {
            Broker::RabbitMq(connection) => Ok(EventSubscription::RabbitMq { channel: connection.create_channel().await?, queue: source.to_string() }),
            Broker::PubSub(pubsub) => Ok(EventSubscription::PubSub { broker: pubsub.clone(), subscription: source.to_string(), dlx: t.dlx.clone() }),
        }
    }

    pub async fn close(&self) {
        if let Broker::RabbitMq(connection) = self {
            let _ = connection.close(200, "done").await;
        }
    }
}

/// Publishes to one destination; publish returns only once the broker has durably accepted the message.
pub enum EventPublisher {
    RabbitMq { channel: Channel, exchange: String },
    PubSub { broker: PubSubBroker, topic: String },
}

impl EventPublisher {
    pub fn system(&self) -> &'static str {
        match self {
            EventPublisher::RabbitMq { .. } => "rabbitmq",
            EventPublisher::PubSub { .. } => "gcp_pubsub",
        }
    }

    pub fn destination(&self) -> &str {
        match self {
            EventPublisher::RabbitMq { exchange, .. } => exchange,
            EventPublisher::PubSub { topic, .. } => topic,
        }
    }

    pub async fn publish(&self, m: &BrokerMessage) -> Result<(), RuntimeError> {
        match self {
            EventPublisher::RabbitMq { channel, exchange } => {
                let mut headers = FieldTable::default();
                if let Some(tenant) = &m.tenant_id {
                    headers.insert("tenant_id".into(), AMQPValue::LongString(tenant.clone().into()));
                }
                if let Some(tp) = &m.traceparent {
                    headers.insert("traceparent".into(), AMQPValue::LongString(tp.clone().into()));
                }
                let key = m.event_type.clone().unwrap_or_default();
                let properties = BasicProperties::default()
                    .with_message_id(m.message_id.clone().into())
                    .with_delivery_mode(2)
                    .with_content_type("application/json".into())
                    .with_type(key.clone().into())
                    .with_headers(headers);
                let confirm = channel.basic_publish(exchange, &key, BasicPublishOptions::default(), &m.body, properties).await?;
                let confirmation = tokio::time::timeout(Duration::from_secs(10), confirm)
                    .await
                    .map_err(|_| RuntimeError::Other("publisher confirm timed out".into()))??;
                if confirmation.is_ack() {
                    Ok(())
                } else {
                    Err(RuntimeError::Other("message was not acknowledged by the broker".into()))
                }
            }
            EventPublisher::PubSub { broker, topic } => broker.publish_to(topic, m).await,
        }
    }

    pub async fn close(&self) {
        if let EventPublisher::RabbitMq { channel, .. } = self {
            let _ = channel.close(200, "done").await;
        }
    }
}

/// How a received message is acknowledged or dead-lettered.
enum Settle {
    RabbitMq(AmqpDelivery),
    PubSub { broker: PubSubBroker, subscription: String, ack_id: String, dlx: String },
}

/// A received message: ack() once processed; dead_letter() moves it to the DLQ (it is not redelivered).
pub struct Delivery {
    pub message: BrokerMessage,
    settle: Settle,
}

impl Delivery {
    pub async fn ack(&self) -> Result<(), RuntimeError> {
        match &self.settle {
            Settle::RabbitMq(delivery) => Ok(delivery.ack(BasicAckOptions::default()).await?),
            Settle::PubSub { broker, subscription, ack_id, .. } => broker.acknowledge(subscription, ack_id).await,
        }
    }

    pub async fn dead_letter(&self) -> Result<(), RuntimeError> {
        match &self.settle {
            // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
            Settle::RabbitMq(delivery) => Ok(delivery.nack(BasicNackOptions { requeue: false, ..Default::default() }).await?),
            Settle::PubSub { broker, subscription, ack_id, dlx } => {
                broker.publish_to(dlx, &self.message).await?;
                broker.acknowledge(subscription, ack_id).await
            }
        }
    }
}

/// Pulls messages from one queue / subscription.
pub enum EventSubscription {
    RabbitMq { channel: Channel, queue: String },
    PubSub { broker: PubSubBroker, subscription: String, dlx: String },
}

fn header(headers: &Option<FieldTable>, key: &str) -> Option<String> {
    match headers.as_ref()?.inner().get(key)? {
        AMQPValue::LongString(value) => Some(String::from_utf8_lossy(value.as_bytes()).into_owned()),
        AMQPValue::ShortString(value) => Some(value.as_str().to_string()),
        _ => None,
    }
}

impl EventSubscription {
    pub fn system(&self) -> &'static str {
        match self {
            EventSubscription::RabbitMq { .. } => "rabbitmq",
            EventSubscription::PubSub { .. } => "gcp_pubsub",
        }
    }

    pub fn source(&self) -> &str {
        match self {
            EventSubscription::RabbitMq { queue, .. } => queue,
            EventSubscription::PubSub { subscription, .. } => subscription,
        }
    }

    /// The next waiting message, or None when there is none.
    pub async fn poll(&self) -> Result<Option<Delivery>, RuntimeError> {
        match self {
            EventSubscription::RabbitMq { channel, queue } => {
                let Some(got) = channel.basic_get(queue, BasicGetOptions { no_ack: false }).await? else { return Ok(None) };
                let delivery = got.delivery;
                let props = &delivery.properties;
                let message = BrokerMessage {
                    message_id: props.message_id().as_ref().map(|id| id.as_str().to_string()).unwrap_or_default(),
                    event_type: props.kind().as_ref().map(|k| k.as_str().to_string()),
                    tenant_id: header(props.headers(), "tenant_id"),
                    traceparent: header(props.headers(), "traceparent"),
                    body: delivery.data.clone(),
                };
                Ok(Some(Delivery { message, settle: Settle::RabbitMq(delivery) }))
            }
            EventSubscription::PubSub { broker, subscription, dlx } => broker.pull(subscription, dlx).await,
        }
    }

    pub async fn close(&self) {
        if let EventSubscription::RabbitMq { channel, .. } = self {
            let _ = channel.close(200, "done").await;
        }
    }
}

const METADATA_TOKEN: &str = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/// Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
/// subscriptions for the queue and the DLQ. publish returns once Pub/Sub has stored the message. A failed message is
/// dead-lettered by the consumer: published to the DLX topic, then acknowledged.
/// Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server
/// token of the workload's service account (Cloud Run, GKE workload identity).
#[derive(Clone)]
pub struct PubSubBroker {
    http: reqwest::Client,
    project: String,
    root: String,
    emulator: bool,
    token: Arc<Mutex<Option<(String, Instant)>>>,
}

impl PubSubBroker {
    pub fn new(project: &str, emulator_host: Option<String>) -> Self {
        let emulator = emulator_host.is_some();
        let base = emulator_host.map(|h| format!("http://{h}")).unwrap_or_else(|| "https://pubsub.googleapis.com".into());
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client");
        Self { http, project: project.to_string(), root: format!("{base}/v1/projects/{project}"), emulator, token: Arc::new(Mutex::new(None)) }
    }

    pub fn from_env() -> Result<Self, RuntimeError> {
        let project = env("PUBSUB_PROJECT_ID").or_else(|| env("GOOGLE_CLOUD_PROJECT"))
            .ok_or_else(|| RuntimeError::Other("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set".into()))?;
        Ok(Self::new(&project, env("PUBSUB_EMULATOR_HOST")))
    }

    async fn bearer(&self) -> Result<Option<String>, RuntimeError> {
        if self.emulator {
            return Ok(None);
        }
        if let Some(token) = env("GOOGLE_OAUTH_ACCESS_TOKEN") {
            return Ok(Some(token));
        }
        let mut cached = self.token.lock().await;
        if let Some((token, expires)) = cached.as_ref() {
            if Instant::now() < *expires {
                return Ok(Some(token.clone()));
            }
        }
        let res = self.http.get(METADATA_TOKEN).header("Metadata-Flavor", "Google").send().await.map_err(other)?;
        let body: Value = serde_json::from_slice(&res.bytes().await.map_err(other)?)?;
        let token = body["access_token"].as_str().unwrap_or_default().to_string();
        let expires = Instant::now() + Duration::from_secs(body["expires_in"].as_u64().unwrap_or(300).saturating_sub(60));
        *cached = Some((token.clone(), expires));
        Ok(Some(token))
    }

    /// Calls the API; a status listed in \`accepted\` returns Ok(None) instead of failing.
    async fn call(&self, method: reqwest::Method, path: &str, body: Value, accepted: &[u16]) -> Result<Option<Value>, RuntimeError> {
        let mut req = self.http.request(method.clone(), format!("{}{path}", self.root)).header("Content-Type", "application/json").body(body.to_string());
        if let Some(token) = self.bearer().await? {
            req = req.bearer_auth(token);
        }
        let res = req.send().await.map_err(other)?;
        let status = res.status();
        let raw = res.bytes().await.map_err(other)?;
        if status.is_success() {
            return Ok(Some(if raw.is_empty() { json!({}) } else { serde_json::from_slice(&raw)? }));
        }
        if accepted.contains(&status.as_u16()) {
            return Ok(None);
        }
        Err(RuntimeError::Other(format!("pub/sub {method} {path} failed: {status} {}", String::from_utf8_lossy(&raw))))
    }

    async fn declare(&self, t: &Topology) -> Result<(), RuntimeError> {
        // 409: it already exists (created earlier or by infrastructure as code).
        let project = &self.project;
        self.call(reqwest::Method::PUT, &format!("/topics/{}", t.exchange), json!({}), &[409]).await?;
        self.call(reqwest::Method::PUT, &format!("/topics/{}", t.dlx), json!({}), &[409]).await?;
        self.call(reqwest::Method::PUT, &format!("/subscriptions/{}", t.queue), json!({"topic": format!("projects/{project}/topics/{}", t.exchange), "ackDeadlineSeconds": 60}), &[409]).await?;
        self.call(reqwest::Method::PUT, &format!("/subscriptions/{}", t.dlq), json!({"topic": format!("projects/{project}/topics/{}", t.dlx), "ackDeadlineSeconds": 60}), &[409]).await?;
        Ok(())
    }

    async fn publish_to(&self, topic: &str, m: &BrokerMessage) -> Result<(), RuntimeError> {
        let mut attributes = serde_json::Map::new();
        attributes.insert("ghk_message_id".into(), json!(m.message_id));
        for (key, value) in [("event_type", &m.event_type), ("tenant_id", &m.tenant_id), ("traceparent", &m.traceparent)] {
            if let Some(v) = value {
                attributes.insert(key.into(), json!(v));
            }
        }
        let res = self.call(reqwest::Method::POST, &format!("/topics/{topic}:publish"), json!({"messages": [{"data": STANDARD.encode(&m.body), "attributes": attributes}]}), &[]).await?;
        match res.as_ref().and_then(|r| r["messageIds"].as_array()).map(|ids| ids.len()) {
            Some(1) => Ok(()),
            _ => Err(RuntimeError::Other(format!("pub/sub did not accept message {}", m.message_id))),
        }
    }

    async fn acknowledge(&self, subscription: &str, ack_id: &str) -> Result<(), RuntimeError> {
        self.call(reqwest::Method::POST, &format!("/subscriptions/{subscription}:acknowledge"), json!({"ackIds": [ack_id]}), &[]).await.map(|_| ())
    }

    async fn pull(&self, subscription: &str, dlx: &str) -> Result<Option<Delivery>, RuntimeError> {
        let res = self.call(reqwest::Method::POST, &format!("/subscriptions/{subscription}:pull"), json!({"maxMessages": 1, "returnImmediately": true}), &[]).await?;
        let Some(first) = res.as_ref().and_then(|r| r["receivedMessages"].as_array()).and_then(|a| a.first()).cloned() else { return Ok(None) };
        let msg = &first["message"];
        let attr = |key: &str| msg["attributes"][key].as_str().map(str::to_string);
        let body = STANDARD.decode(msg["data"].as_str().unwrap_or_default()).map_err(other)?;
        let message = BrokerMessage {
            message_id: attr("ghk_message_id").unwrap_or_else(|| msg["messageId"].as_str().unwrap_or_default().to_string()),
            event_type: attr("event_type"),
            tenant_id: attr("tenant_id"),
            traceparent: attr("traceparent"),
            body,
        };
        let ack_id = first["ackId"].as_str().unwrap_or_default().to_string();
        Ok(Some(Delivery { message, settle: Settle::PubSub { broker: self.clone(), subscription: subscription.to_string(), ack_id, dlx: dlx.to_string() } }))
    }
}

fn other(e: impl std::fmt::Display) -> RuntimeError {
    RuntimeError::Other(e.to_string())
}
`;

  const relay = `use opentelemetry::trace::SpanKind;
use opentelemetry::KeyValue;
use sqlx::PgPool;

use super::broker::{BrokerMessage, EventPublisher};
use super::{schema_name, telemetry, RuntimeError};

/// Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
/// concurrent relays never publish the same row; the publisher returns only once the broker has
/// accepted the message (RabbitMQ confirms, Pub/Sub publish), before a row is marked published.
/// Use one relay (and publisher) per task.
pub struct OutboxRelay {
    pool: PgPool,
    publisher: EventPublisher,
    s: String,
    pub lease_seconds: f64,
    pub max_attempts: i32,
}

impl OutboxRelay {
    pub fn new(pool: PgPool, publisher: EventPublisher, schema: &str) -> Result<Self, RuntimeError> {
        let s = schema_name(schema)?;
        Ok(Self { pool, publisher, s, lease_seconds: ${LEASE_SECONDS}.0, max_attempts: ${MAX_PUBLISH_ATTEMPTS} })
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
            let destination = self.publisher.destination().to_string();
            let cx = telemetry::start_span(
                &telemetry::context_from(traceparent.as_deref()),
                format!("{destination} publish"),
                SpanKind::Producer,
                vec![
                    KeyValue::new("messaging.system", self.publisher.system()),
                    KeyValue::new("messaging.destination.name", destination),
                    KeyValue::new("messaging.message.id", id.clone()),
                    KeyValue::new("tenant.id", tenant.clone()),
                ],
            );
            let message = BrokerMessage {
                message_id: id.clone(),
                event_type: Some(event_type),
                tenant_id: Some(tenant),
                traceparent: telemetry::traceparent_of(&cx),
                body: payload.into_bytes(),
            };
            let mut outcome = self.publisher.publish(&message).await;
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
}
`;

  const inbox = `use std::time::Duration;

use futures_util::future::BoxFuture;
use opentelemetry::trace::SpanKind;
use opentelemetry::KeyValue;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};

use super::broker::{Delivery, EventSubscription};
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
/// are acknowledged without running the handler twice. A handler error dead-letters the message
/// (RabbitMQ DLX, Pub/Sub dead-letter topic): it is not redelivered.
pub struct InboxConsumer {
    pool: PgPool,
    subscription: EventSubscription,
    name: String,
    handler: Handler,
    s: String,
}

impl InboxConsumer {
    pub fn new<F>(pool: PgPool, subscription: EventSubscription, name: &str, schema: &str, handler: F) -> Result<Self, RuntimeError>
    where
        F: for<'a> Fn(Value, Meta, &'a mut PgConnection) -> BoxFuture<'a, Result<(), String>> + Send + Sync + 'static,
    {
        Ok(Self { pool, subscription, name: name.to_string(), handler: Box::new(handler), s: schema_name(schema)? })
    }

    /// Processes messages until the source stays idle for \`idle\`; returns how many were processed.
    pub async fn drain(&self, idle: Duration) -> Result<usize, RuntimeError> {
        let mut processed = 0;
        let mut idle_since = std::time::Instant::now();
        while idle_since.elapsed() < idle {
            match self.subscription.poll().await? {
                Some(delivery) => {
                    self.process(delivery).await;
                    processed += 1;
                    idle_since = std::time::Instant::now();
                }
                None => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        Ok(processed)
    }

    /// Closes the underlying subscription (channel).
    pub async fn close(&self) {
        self.subscription.close().await;
    }

    async fn process(&self, delivery: Delivery) {
        let message = &delivery.message;
        let meta = Meta {
            message_id: message.message_id.clone(),
            tenant_id: message.tenant_id.clone().unwrap_or_default(),
            event_type: message.event_type.clone().unwrap_or_default(),
        };
        let cx = telemetry::start_span(
            &telemetry::context_from(message.traceparent.as_deref()),
            format!("{} process", self.subscription.source()),
            SpanKind::Consumer,
            vec![
                KeyValue::new("messaging.system", self.subscription.system()),
                KeyValue::new("messaging.destination.name", self.subscription.source().to_string()),
                KeyValue::new("messaging.message.id", message.message_id.clone()),
            ],
        );
        match self.handle(&message.body, meta).await {
            Ok(()) => {
                let _ = delivery.ack().await;
                telemetry::finish(&cx, None);
            }
            Err(error) => {
                let _ = delivery.dead_letter().await;
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

  const test = `//! Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and the selected broker
//! (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST]).
//! Requires DATABASE_URL. Run with:
//! cargo test --features integration --test runtime_integration -- --test-threads=1
#![cfg(feature = "integration")]

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use opentelemetry::trace::SpanKind;
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use ${crate}::runtime::{broker_configured, migrate, Broker, BrokerMessage, CommandRequest, CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, SagaStep, Topology};

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
    broker: Broker,
    schema: String,
    topology: Topology,
}

impl Env {
    /// Receives and acknowledges messages until \`expected\` arrived and the source stays quiet for 500 ms (10 s at most).
    async fn receive(&self, source: &str, expected: usize) -> Vec<BrokerMessage> {
        let subscription = self.broker.subscribe(source, &self.topology).await.expect("subscribe");
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut quiet_since = Instant::now();
        while Instant::now() < deadline && (out.len() < expected || quiet_since.elapsed() < Duration::from_millis(500)) {
            match subscription.poll().await.expect("poll") {
                Some(delivery) => {
                    delivery.ack().await.expect("ack");
                    out.push(delivery.message);
                    quiet_since = Instant::now();
                }
                None => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        subscription.close().await;
        out
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
        self.broker.close().await;
    }
}

fn uid() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

async fn setup() -> Env {
    let db_url = std::env::var("DATABASE_URL").expect("integration tests need DATABASE_URL (see docs/RUNTIME-KERNEL.md)");
    assert!(broker_configured(), "integration tests need the broker variables (see docs/RUNTIME-KERNEL.md)");
    exporter().reset();
    let pool = PgPoolOptions::new().max_connections(10).connect(&db_url).await.expect("postgres");
    let broker = Broker::connect().await.expect("broker");
    let env = Env { pool, broker, schema: format!("it_{}", uid()), topology: Topology::for_prefix(&format!("it-{}", uid())) };
    migrate(&env.pool, &env.schema).await.expect("migrate");
    env.broker.declare(&env.topology).await.expect("topology");
    env
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
    let run = |worker: &'static str| {
        let env = &env;
        async move {
            let publisher = env.broker.publisher(&env.topology.exchange).await.expect("publisher");
            let relay = OutboxRelay::new(env.pool.clone(), publisher, &env.schema).expect("relay");
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
    let received = env.receive(&env.topology.queue, 20).await;
    let ids: HashSet<String> = received.iter().map(|m| m.message_id.clone()).collect();
    assert_eq!((received.len(), ids.len()), (20, 20));
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
    let handled = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = handled.clone();
    let subscription = env.broker.subscribe(&env.topology.queue, &env.topology).await.expect("subscribe");
    let consumer = InboxConsumer::new(env.pool.clone(), subscription, "it-consumer", &env.schema, move |event, meta, _conn| {
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
    let publisher = env.broker.publisher(&env.topology.exchange).await.expect("publisher");
    for (id, body) in [("m-1", r#"{"ok": true}"#), ("m-1", r#"{"ok": true}"#), ("m-poison", r#"{"poison": true}"#)] {
        let message = BrokerMessage { message_id: id.into(), event_type: Some("Test".into()), tenant_id: Some("t1".into()), traceparent: None, body: body.as_bytes().to_vec() };
        publisher.publish(&message).await.expect("publish");
    }
    publisher.close().await;
    consumer.drain(Duration::from_secs(1)).await.expect("drain");
    consumer.close().await;
    assert_eq!(*handled.lock().unwrap(), vec!["m-1"]);
    assert_eq!(env.count("ghk_inbox", "consumer = $1", Some("it-consumer")).await, 1);
    let dead: Vec<String> = env.receive(&env.topology.dlq, 1).await.into_iter().map(|m| m.message_id).collect();
    assert_eq!(dead, vec!["m-poison"]);
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

    let publisher = env.broker.publisher(&env.topology.exchange).await.expect("publisher");
    let relay = OutboxRelay::new(env.pool.clone(), publisher, &env.schema).expect("relay");
    assert_eq!(relay.publish_batch("relay", 10).await.expect("publish"), 1);
    let received = Arc::new(Mutex::new(0));
    let counter = received.clone();
    let subscription = env.broker.subscribe(&env.topology.queue, &env.topology).await.expect("subscribe");
    let consumer = InboxConsumer::new(env.pool.clone(), subscription, "trace-consumer", &env.schema, move |_, _, _| {
        *counter.lock().unwrap() += 1;
        Box::pin(async { Ok(()) })
    })
    .expect("consumer");
    consumer.drain(Duration::from_secs(1)).await.expect("drain");
    consumer.close().await;
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
    { filename: 'src/runtime/otel.rs', content: `//! OpenTelemetry export of the running service. With OTEL_EXPORTER_OTLP_ENDPOINT set, spans go over OTLP/HTTP to
//! that collector (service.name from OTEL_SERVICE_NAME); without it nothing is exported and nothing connects.
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;

/// Installs the global tracer provider; keep the returned provider and call \`shutdown()\` on exit to flush.
pub fn start_telemetry() -> Option<SdkTracerProvider> {
    if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").map(|v| v.is_empty()).unwrap_or(true) {
        return None;
    }
    let exporter = match opentelemetry_otlp::SpanExporter::builder().with_http().build() {
        Ok(exporter) => exporter,
        Err(err) => {
            eprintln!("telemetry export disabled: {err}");
            return None;
        }
    };
    let name = std::env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| ${JSON.stringify(m.service || m.kebab)}.to_string());
    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(Resource::builder().with_service_name(name).build())
        .build();
    opentelemetry::global::set_tracer_provider(provider.clone());
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());
    Some(provider)
}
` },
    { filename: 'src/runtime/command_service.rs', content: commandService },
    { filename: 'src/runtime/broker.rs', content: broker },
    { filename: 'src/runtime/outbox_relay.rs', content: relay },
    { filename: 'src/runtime/inbox_consumer.rs', content: inbox },
    { filename: 'src/runtime/saga.rs', content: saga },
    { filename: 'tests/runtime_integration.rs', content: test }
  ];
}
