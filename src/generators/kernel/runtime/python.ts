/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Python (FastAPI, Django)
   psycopg 3 + pika + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor, usesKafka, usesServiceBus } from './jvm';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface PyRuntimeFile {
  filename: string;
  content: string;
}

export const PY_RUNTIME_DEPENDENCIES = ['psycopg[binary]>=3.2', 'pika>=1.3', 'opentelemetry-api>=1.27', 'opentelemetry-sdk>=1.27', 'opentelemetry-exporter-otlp-proto-http>=1.27'];

/** Azure SDK packages, added only for stack.messaging "servicebus". */
export const PY_SERVICEBUS_DEPENDENCIES = ['azure-servicebus>=7.15', 'azure-identity>=1.26'];

/** Confluent's official Kafka client, added only for stack.messaging "kafka". */
export const PY_KAFKA_DEPENDENCIES = ['confluent-kafka>=2.12'];

/** Runtime dependencies for a stack.messaging value. */
export function pyRuntimeDependencies(messaging?: string): string[] {
  return [
    ...PY_RUNTIME_DEPENDENCIES,
    ...(usesServiceBus(messaging) ? PY_SERVICEBUS_DEPENDENCIES : []),
    ...(usesKafka(messaging) ? PY_KAFKA_DEPENDENCIES : [])
  ];
}

/** pytest ini lines registering the marker the integration suite uses. */
export const PY_INTEGRATION_MARKER = 'markers = ["integration: runtime tests against PostgreSQL and RabbitMQ (DATABASE_URL, AMQP_URL)"]';

const pyStr = (s: string) => JSON.stringify(s);

export function renderPyRuntime(m: DomainModel, pkg = 'app', siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): PyRuntimeFile[] {
  const serviceBus = usesServiceBus(messaging);
  const kafka = usesKafka(messaging);
  const defaultBroker = defaultBrokerFor(messaging);
  const all = [m, ...siblings];
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `    ${pyStr(s)},`).join('\n');

  const telemetry = `"""W3C trace-context helpers. Spans go to the globally configured tracer provider
(configure exporters with the standard OTEL_* environment variables)."""
from __future__ import annotations

from typing import Optional

from opentelemetry import context as otel_context, trace
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

_propagator = TraceContextTextMapPropagator()


def tracer() -> trace.Tracer:
    return trace.get_tracer(${pyStr(m.kebab)})


def context_from(traceparent: Optional[str]) -> otel_context.Context:
    """Context whose parent is the span described by an incoming traceparent header."""
    if not traceparent:
        return otel_context.get_current()
    return _propagator.extract({"traceparent": traceparent})


def traceparent_of(ctx: otel_context.Context) -> Optional[str]:
    carrier: dict = {}
    _propagator.inject(carrier, context=ctx)
    return carrier.get("traceparent")
`;

  const schema = `"""Runtime tables (docs/RUNTIME-KERNEL.md)."""
from __future__ import annotations

import re

import psycopg

STATEMENTS = [
${statements}
]

${RLS_NOTE.split('\n').map(l => l.replace(/^-- ?/, '# ')).join('\n')}


def schema_name(schema: str = "public") -> str:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise ValueError(f"Invalid schema name: {schema}")
    return schema


def migrate(dsn: str, schema: str = "public") -> None:
    s = schema_name(schema)
    with psycopg.connect(dsn, autocommit=True) as conn:
        for statement in STATEMENTS:
            conn.execute(statement.replace(${pyStr(SCHEMA_TOKEN)}, s))
`;

  const commandService = `"""Executes commands in one transaction: idempotency claim, aggregate load (FOR UPDATE),
domain logic, aggregate save and outbox insert. A domain error rolls everything back."""
from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, Optional

import psycopg
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from ${pkg}.domain import DomainValidationError, ${all.map(a => `${a.pascal}Aggregate, ${a.pascal}Command, ${a.pascal}State`).join(', ')}
from .schema import schema_name
from .telemetry import context_from, traceparent_of, tracer

# Aggregate type used when a request does not name one.
DEFAULT_AGGREGATE = ${pyStr(m.pascal)}

# Every aggregate of the service: (aggregate class, state enum, command class, commands).
AGGREGATES: Dict[str, Any] = {
${all.map(a => `    ${pyStr(a.pascal)}: (${a.pascal}Aggregate, ${a.pascal}State, ${a.pascal}Command, {
${a.commands.map(c => `        ${pyStr(c.snake)}: lambda agg, cmd: agg.${c.snake}(cmd),`).join('\n')}
    }),`).join('\n')}
}


@dataclass
class CommandResult:
    status: str
    aggregate_id: str
    event_type: Optional[str] = None
    version: Optional[int] = None


def _event_json(event: Any) -> str:
    return json.dumps({
        "type": event.type.value,
        "aggregateId": event.aggregate_id,
        "version": event.version,
        "occurredOn": event.occurred_on.isoformat(),
        "payload": event.payload,
    })


class CommandService:
    def __init__(self, dsn: str, schema: str = "public") -> None:
        self.dsn = dsn
        self.s = schema_name(schema)

    def handle(self, tenant_id: str, aggregate_id: str, command: str, payload: Optional[Dict[str, Any]] = None,
               idempotency_key: Optional[str] = None, traceparent: Optional[str] = None,
               aggregate_type: Optional[str] = None) -> CommandResult:
        if not tenant_id:
            raise DomainValidationError("tenant_id is required")
        aggregate_type = aggregate_type or DEFAULT_AGGREGATE
        if aggregate_type not in AGGREGATES:
            raise DomainValidationError(f"Unknown aggregate type {aggregate_type}")
        parent = context_from(traceparent)
        with tracer().start_as_current_span(f"{aggregate_type}.{command}", context=parent, kind=SpanKind.INTERNAL,
                                            attributes={"tenant.id": tenant_id, "aggregate.id": aggregate_id}) as span:
            try:
                return self._handle(aggregate_type, tenant_id, aggregate_id, command, payload or {}, idempotency_key, trace.set_span_in_context(span, parent))
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR, str(err)))
                raise

    def _handle(self, aggregate_type, tenant_id, aggregate_id, command, payload, key, ctx) -> CommandResult:
        cls, state_cls, command_cls, commands = AGGREGATES[aggregate_type]
        s = self.s
        with psycopg.connect(self.dsn) as conn:  # one transaction; rolled back on exception
            if key:
                claimed = conn.execute(f"INSERT INTO {s}.ghk_idempotency (tenant_id, key, status) VALUES (%s, %s, 'PROCESSING') ON CONFLICT DO NOTHING", (tenant_id, key))
                if claimed.rowcount == 0:
                    row = conn.execute(f"SELECT status, response FROM {s}.ghk_idempotency WHERE tenant_id = %s AND key = %s", (tenant_id, key)).fetchone()
                    conn.commit()
                    if row and row[0] == "COMPLETED":
                        return CommandResult(**{**json.loads(row[1]), "status": "replayed"})
                    return CommandResult("in-progress", aggregate_id)
            row = conn.execute(f"SELECT state, version FROM {s}.ghk_aggregates WHERE tenant_id = %s AND aggregate_type = %s AND id = %s FOR UPDATE",
                               (tenant_id, aggregate_type, aggregate_id)).fetchone()
            aggregate = cls.restore(aggregate_id, state_cls(row[0]), int(row[1])) if row else cls(aggregate_id)
            handler = commands.get(command)
            if handler is None:
                raise DomainValidationError(f"Unknown command {command}")
            event = handler(aggregate, command_cls(aggregate_id, payload))
            conn.execute(
                f"INSERT INTO {s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (%s, %s, %s, %s, %s) "
                f"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
                (tenant_id, aggregate_type, aggregate_id, aggregate.state.value, aggregate.version))
            conn.execute(
                f"INSERT INTO {s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (%s, %s, %s, %s, %s, %s)",
                (str(uuid.uuid4()), tenant_id, aggregate_id, event.type.value, _event_json(event), traceparent_of(ctx)))
            result = CommandResult("created", aggregate_id, event.type.value, event.version)
            if key:
                conn.execute(f"UPDATE {s}.ghk_idempotency SET status = 'COMPLETED', response = %s WHERE tenant_id = %s AND key = %s",
                             (json.dumps(asdict(result)), tenant_id, key))
            conn.commit()
            return result

    def load(self, tenant_id: str, aggregate_id: str, aggregate_type: str = DEFAULT_AGGREGATE) -> Optional[Dict[str, Any]]:
        """The aggregate as tenant \`tenant_id\` sees it (None for other tenants' aggregates)."""
        with psycopg.connect(self.dsn) as conn:
            row = conn.execute(f"SELECT state, version FROM {self.s}.ghk_aggregates WHERE tenant_id = %s AND aggregate_type = %s AND id = %s",
                               (tenant_id, aggregate_type, aggregate_id)).fetchone()
        return {"state": row[0], "version": int(row[1])} if row else None
`;

  const relay = `"""Outbox relay."""
from __future__ import annotations

import json

import psycopg
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .broker import BrokerMessage, EventPublisher
from .schema import schema_name
from .telemetry import context_from, traceparent_of, tracer


class OutboxRelay:
    """Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
    concurrent relays never publish the same row; the publisher returns only once the broker has
    accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before a row is marked
    published. Use one relay (and publisher) per thread."""

    def __init__(self, dsn: str, publisher: EventPublisher, schema: str = "public",
                 lease_seconds: int = ${LEASE_SECONDS}, max_attempts: int = ${MAX_PUBLISH_ATTEMPTS}) -> None:
        self.dsn = dsn
        self.publisher = publisher
        self.s = schema_name(schema)
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts

    def publish_batch(self, worker_id: str, limit: int = 50) -> int:
        s = self.s
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            rows = conn.execute(
                f"UPDATE {s}.ghk_outbox SET claimed_by = %s, claimed_until = now() + make_interval(secs => %s), attempts = attempts + 1 "
                f"WHERE id IN (SELECT id FROM {s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL "
                f"AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED) "
                f"RETURNING id, tenant_id, aggregate_id, event_type, payload, traceparent",
                (worker_id, self.lease_seconds, limit)).fetchall()
            published = 0
            for (id_, tenant_id, _aggregate_id, event_type, payload, traceparent) in rows:
                parent = context_from(traceparent)
                destination = self.publisher.destination
                with tracer().start_as_current_span(f"{destination} publish", context=parent, kind=SpanKind.PRODUCER,
                                                    attributes={"messaging.system": self.publisher.system, "messaging.destination.name": destination,
                                                                "messaging.message.id": id_, "tenant.id": tenant_id}) as span:
                    try:
                        tp = traceparent_of(trace.set_span_in_context(span, parent))
                        body = payload if isinstance(payload, str) else json.dumps(payload)
                        self.publisher.publish(BrokerMessage(id_, event_type, tenant_id, tp, body.encode("utf-8")))
                        conn.execute(f"UPDATE {s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = %s AND claimed_by = %s", (id_, worker_id))
                        published += 1
                    except Exception as err:  # broker unavailable / nacked: release the lease, retry later
                        span.record_exception(err)
                        span.set_status(Status(StatusCode.ERROR))
                        conn.execute(
                            f"UPDATE {s}.ghk_outbox SET claimed_until = NULL, last_error = %s, "
                            f"failed_at = CASE WHEN attempts >= %s THEN now() ELSE NULL END WHERE id = %s",
                            (str(err), self.max_attempts, id_))
            return published
`;

  const broker = `"""The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on
any cloud: GHK_BROKER=rabbitmq (AMQP_URL), pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT; PUBSUB_EMULATOR_HOST)
or servicebus (SERVICEBUS_NAMESPACE or SERVICEBUS_CONNECTION_STRING). Without GHK_BROKER the configured
variables decide, then stack.messaging."""
from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

import pika


@dataclass(frozen=True)
class Topology:
    """Publish to exchange (topic), consume from queue (subscription); dead letters go to dlx, read from dlq."""
    exchange: str
    queue: str
    dlx: str
    dlq: str


def topology(prefix: str = ${pyStr(t.exchange.replace(/\.events$/, ''))}) -> Topology:
    return Topology(f"{prefix}.events", f"{prefix}.consumer", f"{prefix}.dlx", f"{prefix}.dlq")


DEFAULT_TOPOLOGY = Topology(${pyStr(t.exchange)}, ${pyStr(t.queue)}, ${pyStr(t.dlx)}, ${pyStr(t.dlq)})

# Broker of the generated configuration (stack.messaging).
DEFAULT_BROKER = ${pyStr(defaultBroker)}


@dataclass(frozen=True)
class BrokerMessage:
    """A domain event on the wire, independent of the broker."""
    message_id: str
    event_type: Optional[str]
    tenant_id: Optional[str]
    traceparent: Optional[str]
    body: bytes


@dataclass
class Delivery:
    """A received message: ack() once processed; dead_letter() moves it to the DLQ (it is not redelivered)."""
    message: BrokerMessage
    ack: Callable[[], None]
    dead_letter: Callable[[], None]


class EventPublisher:
    """Publishes to one destination; publish returns only once the broker has durably accepted the message."""
    system = ""
    destination = ""

    def publish(self, message: BrokerMessage) -> None:
        raise NotImplementedError

    def close(self) -> None:
        pass


class EventSubscription:
    """Pulls messages from one queue / subscription."""
    system = ""
    source = ""

    def poll(self) -> Optional[Delivery]:
        """The next waiting message, or None when there is none."""
        raise NotImplementedError

    def close(self) -> None:
        pass


class Broker:
    system = ""
    # False when topics cannot be created at run time (Service Bus emulator: fixed Config.json).
    dynamic_topology = True

    def declare(self, t: Topology) -> None:
        """Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code."""
        raise NotImplementedError

    def publisher(self, destination: str) -> EventPublisher:
        raise NotImplementedError

    def subscribe(self, source: str, t: Topology) -> EventSubscription:
        """t: where dead-lettered messages go."""
        raise NotImplementedError

    def close(self) -> None:
        pass


def broker_kind(env=os.environ) -> str:
    if env.get("GHK_BROKER", "").strip():
        return env["GHK_BROKER"].strip().lower()
    if env.get("AMQP_URL"):
        return "rabbitmq"
    if env.get("PUBSUB_PROJECT_ID") or env.get("PUBSUB_EMULATOR_HOST"):
        return "pubsub"
    if env.get("SERVICEBUS_CONNECTION_STRING") or env.get("SERVICEBUS_NAMESPACE"):
        return "servicebus"
    if env.get("KAFKA_BOOTSTRAP_SERVERS"):
        return "kafka"
    return DEFAULT_BROKER


def broker_configured(env=os.environ) -> bool:
    """Whether the variables of the selected broker are set."""
    kind = broker_kind(env)
    if kind == "pubsub":
        return bool(env.get("PUBSUB_PROJECT_ID") or env.get("GOOGLE_CLOUD_PROJECT"))
    if kind == "servicebus":
        return bool(env.get("SERVICEBUS_CONNECTION_STRING") or env.get("SERVICEBUS_NAMESPACE"))
    if kind == "kafka":
        return bool(env.get("KAFKA_BOOTSTRAP_SERVERS"))
    return bool(env.get("AMQP_URL"))


def connect_broker(env=os.environ) -> Broker:
    kind = broker_kind(env)
    if kind == "rabbitmq":
        if not env.get("AMQP_URL"):
            raise RuntimeError("AMQP_URL is not set (amqp://user:password@host:5672)")
        return RabbitMqBroker(env["AMQP_URL"])
    if kind == "pubsub":
        return PubSubBroker.from_env(env)
    if kind == "servicebus":
${serviceBus
  ? '        from .servicebus_broker import ServiceBusBroker\n        return ServiceBusBroker.from_env(env)'
  : '        raise RuntimeError(\'The Azure Service Bus adapter is not generated: set stack.messaging to "servicebus" and regenerate\')'}
    if kind == "kafka":
${kafka
  ? '        from .kafka_broker import KafkaBroker\n        return KafkaBroker.from_env(env)'
  : '        raise RuntimeError(\'The Kafka adapter is not generated: set stack.messaging to "kafka" and regenerate\')'}
    raise RuntimeError(f"Unsupported GHK_BROKER: {kind} (rabbitmq, pubsub, servicebus, kafka)")


class RabbitMqBroker(Broker):
    """RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX.
    pika's BlockingConnection is not thread-safe, so each publisher / subscription has its own connection."""
    system = "rabbitmq"

    def __init__(self, url: str) -> None:
        self.url = url

    def _connect(self):
        # A busy host can delay the AMQP handshake: retry before failing.
        for attempt in range(1, 6):
            try:
                return pika.BlockingConnection(pika.URLParameters(self.url))
            except pika.exceptions.AMQPConnectionError:
                if attempt == 5:
                    raise
                time.sleep(2 * attempt)

    def declare(self, t: Topology) -> None:
        connection = self._connect()
        try:
            channel = connection.channel()
            channel.exchange_declare(exchange=t.exchange, exchange_type="topic", durable=True)
            channel.exchange_declare(exchange=t.dlx, exchange_type="fanout", durable=True)
            channel.queue_declare(queue=t.dlq, durable=True)
            channel.queue_bind(queue=t.dlq, exchange=t.dlx, routing_key="")
            channel.queue_declare(queue=t.queue, durable=True, arguments={"x-dead-letter-exchange": t.dlx})
            channel.queue_bind(queue=t.queue, exchange=t.exchange, routing_key="#")
        finally:
            connection.close()

    def publisher(self, exchange: str) -> EventPublisher:
        return _RabbitPublisher(self._connect(), exchange)

    def subscribe(self, queue: str, t: Topology) -> EventSubscription:
        return _RabbitSubscription(self._connect(), queue)


class _RabbitPublisher(EventPublisher):
    system = "rabbitmq"

    def __init__(self, connection, exchange: str) -> None:
        self.connection = connection
        self.channel = connection.channel()
        self.channel.confirm_delivery()
        self.destination = exchange

    def publish(self, m: BrokerMessage) -> None:
        headers = {}
        if m.tenant_id:
            headers["tenant_id"] = m.tenant_id
        if m.traceparent:
            headers["traceparent"] = m.traceparent
        # With confirms on, basic_publish raises if the broker nacks the message.
        self.channel.basic_publish(exchange=self.destination, routing_key=m.event_type or "", body=m.body,
                                   properties=pika.BasicProperties(message_id=m.message_id, delivery_mode=2, content_type="application/json",
                                                                   type=m.event_type, headers=headers))

    def close(self) -> None:
        if self.connection.is_open:
            self.connection.close()


class _RabbitSubscription(EventSubscription):
    system = "rabbitmq"

    def __init__(self, connection, queue: str) -> None:
        self.connection = connection
        self.channel = connection.channel()
        self.source = queue

    def poll(self) -> Optional[Delivery]:
        method, properties, body = self.channel.basic_get(self.source, auto_ack=False)
        if method is None:
            return None
        headers = properties.headers or {}
        text = lambda v: None if v is None else (v.decode() if isinstance(v, bytes) else str(v))
        message = BrokerMessage(str(properties.message_id), properties.type, text(headers.get("tenant_id")), text(headers.get("traceparent")), body)
        tag = method.delivery_tag
        # Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
        return Delivery(message, lambda: self.channel.basic_ack(tag), lambda: self.channel.basic_nack(tag, requeue=False))

    def close(self) -> None:
        if self.connection.is_open:
            self.connection.close()


_METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"


class PubSubBroker(Broker):
    """Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
    subscriptions for the queue and the DLQ. publish returns once Pub/Sub has stored the message. A failed message
    is dead-lettered by the consumer: published to the DLX topic, then acknowledged.
    Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server
    token of the workload's service account (Cloud Run, GKE workload identity)."""
    system = "gcp_pubsub"

    def __init__(self, project: str, emulator_host: Optional[str] = None) -> None:
        self.project = project
        self.emulator = bool(emulator_host)
        self.root = (f"http://{emulator_host}" if self.emulator else "https://pubsub.googleapis.com") + f"/v1/projects/{project}"
        self._token: Optional[str] = None
        self._token_expires_at = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls, env=os.environ) -> "PubSubBroker":
        project = env.get("PUBSUB_PROJECT_ID") or env.get("GOOGLE_CLOUD_PROJECT")
        if not project:
            raise RuntimeError("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set")
        return cls(project, env.get("PUBSUB_EMULATOR_HOST"))

    def _bearer(self) -> Optional[str]:
        if self.emulator:
            return None
        if os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN"):
            return os.environ["GOOGLE_OAUTH_ACCESS_TOKEN"]
        with self._lock:
            if not self._token or time.time() > self._token_expires_at:
                req = urllib.request.Request(_METADATA_TOKEN, headers={"Metadata-Flavor": "Google"})
                with urllib.request.urlopen(req, timeout=5) as res:
                    body = json.loads(res.read())
                self._token = body["access_token"]
                self._token_expires_at = time.time() + body["expires_in"] - 60
            return self._token

    def _call(self, method: str, path: str, body: Any = None, accepted=()) -> Optional[Dict[str, Any]]:
        """Calls the API; a status listed in accepted returns None instead of failing."""
        headers = {"Content-Type": "application/json"}
        bearer = self._bearer()
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.root + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as err:
            if err.code in accepted:
                return None
            raise RuntimeError(f"Pub/Sub {method} {path} failed: {err.code} {err.read().decode(errors='replace')}") from err

    def declare(self, t: Topology) -> None:
        # 409: it already exists (created earlier or by infrastructure as code).
        self._call("PUT", f"/topics/{t.exchange}", {}, accepted=(409,))
        self._call("PUT", f"/topics/{t.dlx}", {}, accepted=(409,))
        self._call("PUT", f"/subscriptions/{t.queue}", {"topic": f"projects/{self.project}/topics/{t.exchange}", "ackDeadlineSeconds": 60}, accepted=(409,))
        self._call("PUT", f"/subscriptions/{t.dlq}", {"topic": f"projects/{self.project}/topics/{t.dlx}", "ackDeadlineSeconds": 60}, accepted=(409,))

    def publish_to(self, topic: str, m: BrokerMessage) -> None:
        attributes = {"ghk_message_id": m.message_id}
        if m.event_type:
            attributes["event_type"] = m.event_type
        if m.tenant_id:
            attributes["tenant_id"] = m.tenant_id
        if m.traceparent:
            attributes["traceparent"] = m.traceparent
        res = self._call("POST", f"/topics/{topic}:publish", {"messages": [{"data": base64.b64encode(m.body).decode(), "attributes": attributes}]})
        if not res or len(res.get("messageIds", [])) != 1:
            raise RuntimeError(f"Pub/Sub did not accept message {m.message_id}")

    def publisher(self, topic: str) -> EventPublisher:
        return _PubSubPublisher(self, topic)

    def subscribe(self, subscription: str, t: Topology) -> EventSubscription:
        return _PubSubSubscription(self, subscription, t)


class _PubSubPublisher(EventPublisher):
    system = "gcp_pubsub"

    def __init__(self, broker: PubSubBroker, topic: str) -> None:
        self.broker = broker
        self.destination = topic

    def publish(self, m: BrokerMessage) -> None:
        self.broker.publish_to(self.destination, m)


class _PubSubSubscription(EventSubscription):
    system = "gcp_pubsub"

    def __init__(self, broker: PubSubBroker, subscription: str, t: Topology) -> None:
        self.broker = broker
        self.source = subscription
        self.t = t

    def poll(self) -> Optional[Delivery]:
        res = self.broker._call("POST", f"/subscriptions/{self.source}:pull", {"maxMessages": 1, "returnImmediately": True}) or {}
        received = res.get("receivedMessages") or []
        if not received:
            return None
        ack_id = received[0]["ackId"]
        msg = received[0]["message"]
        attrs = msg.get("attributes") or {}
        message = BrokerMessage(attrs.get("ghk_message_id") or msg["messageId"], attrs.get("event_type"), attrs.get("tenant_id"),
                                attrs.get("traceparent"), base64.b64decode(msg.get("data", "")))

        def ack() -> None:
            self.broker._call("POST", f"/subscriptions/{self.source}:acknowledge", {"ackIds": [ack_id]})

        def dead_letter() -> None:
            self.broker.publish_to(self.t.dlx, message)
            ack()

        return Delivery(message, ack, dead_letter)
`;

  const kafkaPy = `"""Apache Kafka (Confluent's official client, librdkafka): topics for the exchange and the DLX; the queue and the
DLQ are consumer groups on them. KAFKA_BOOTSTRAP_SERVERS, and for managed clusters (Confluent Cloud, Event Hubs,
MSK with SASL/SCRAM) KAFKA_SECURITY_PROTOCOL, KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD.
publish returns once every in-sync replica has the message (acks=all, idempotent producer). ack() commits the
offset; a message that is neither acked nor dead-lettered is read again by the next poll."""
from __future__ import annotations

import os
import time
from typing import Optional

from confluent_kafka import Consumer, KafkaError, KafkaException, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic

from .broker import Broker, BrokerMessage, Delivery, EventPublisher, EventSubscription, Topology


def _config(env) -> dict:
    servers = env.get("KAFKA_BOOTSTRAP_SERVERS")
    if not servers:
        raise RuntimeError("KAFKA_BOOTSTRAP_SERVERS is not set (host:9092)")
    config = {"bootstrap.servers": servers}
    if env.get("KAFKA_SECURITY_PROTOCOL"):
        config["security.protocol"] = env["KAFKA_SECURITY_PROTOCOL"]
    if env.get("KAFKA_SASL_USERNAME"):
        config.update({
            "sasl.mechanism": env.get("KAFKA_SASL_MECHANISM", "PLAIN"),
            "sasl.username": env["KAFKA_SASL_USERNAME"],
            "sasl.password": env.get("KAFKA_SASL_PASSWORD", ""),
        })
    return config


def _send(producer: Producer, topic: str, m: BrokerMessage) -> None:
    """Produces and waits for the delivery report (acks=all)."""
    errors = []
    headers = [("message_id", m.message_id.encode())]
    for name, value in (("event_type", m.event_type), ("tenant_id", m.tenant_id), ("traceparent", m.traceparent)):
        if value is not None:
            headers.append((name, value.encode()))
    producer.produce(topic, key=m.tenant_id, value=m.body, headers=headers,
                     on_delivery=lambda err, _msg: errors.append(err) if err else None)
    if producer.flush(30) or errors:
        raise KafkaException(errors[0] if errors else KafkaError(KafkaError._MSG_TIMED_OUT))


class KafkaBroker(Broker):
    system = "kafka"

    def __init__(self, config: dict) -> None:
        self.config = config

    @classmethod
    def from_env(cls, env=os.environ) -> "KafkaBroker":
        return cls(_config(env))

    def declare(self, t: Topology) -> None:
        admin = AdminClient(self.config)
        for future in admin.create_topics([NewTopic(t.exchange), NewTopic(t.dlx)]).values():
            try:
                future.result(30)
            except KafkaException as e:
                if e.args[0].code() != KafkaError.TOPIC_ALREADY_EXISTS:
                    raise

    def producer(self) -> Producer:
        return Producer({**self.config, "acks": "all", "enable.idempotence": True})

    def publisher(self, destination: str) -> EventPublisher:
        return _Publisher(self.producer(), destination)

    def subscribe(self, source: str, t: Topology) -> EventSubscription:
        return _Subscription(self, source, t)


class _Publisher(EventPublisher):
    system = "kafka"

    def __init__(self, producer: Producer, topic: str) -> None:
        self.producer = producer
        self.destination = topic

    def publish(self, message: BrokerMessage) -> None:
        _send(self.producer, self.destination, message)

    def close(self) -> None:
        self.producer.flush(5)


class _Subscription(EventSubscription):
    system = "kafka"

    def __init__(self, broker: KafkaBroker, group: str, t: Topology) -> None:
        self.broker = broker
        self.source = group
        self.topology = t
        self.consumer = Consumer({**broker.config, "group.id": group, "enable.auto.commit": False, "auto.offset.reset": "earliest"})
        self.consumer.subscribe([t.dlx if group == t.dlq else t.exchange])
        self.pending = None
        self.dead_letters: Optional[Producer] = None

    def _commit(self, msg) -> None:
        self.consumer.commit(offsets=[TopicPartition(msg.topic(), msg.partition(), msg.offset() + 1)], asynchronous=False)
        self.pending = None

    def poll(self) -> Optional[Delivery]:
        if self.pending is not None:
            # Neither acked nor dead-lettered: read it again, as RabbitMQ redelivers an unacknowledged message.
            p = self.pending
            self.consumer.seek(TopicPartition(p.topic(), p.partition(), p.offset()))
        msg = self.consumer.poll(0.2)
        # A new member gets its partitions only after the group rebalance: wait for it (30 s at most) so the
        # first poll does not report an empty source that merely has not been assigned yet.
        joined = time.monotonic()
        while msg is None and not self.consumer.assignment() and time.monotonic() - joined < 30:
            msg = self.consumer.poll(0.2)
        if msg is None:
            return None
        if msg.error():
            if msg.error().code() == KafkaError._PARTITION_EOF:
                return None
            raise KafkaException(msg.error())
        self.pending = msg
        headers = {k: v.decode() for k, v in (msg.headers() or []) if v is not None}
        message = BrokerMessage(headers.get("message_id") or f"{msg.topic()}-{msg.partition()}-{msg.offset()}",
                                headers.get("event_type"), headers.get("tenant_id"), headers.get("traceparent"), msg.value() or b"")

        def dead_letter() -> None:
            if self.dead_letters is None:
                self.dead_letters = self.broker.producer()
            _send(self.dead_letters, self.topology.dlx, message)
            self._commit(msg)

        return Delivery(message, lambda: self._commit(msg), dead_letter)

    def close(self) -> None:
        if self.dead_letters is not None:
            self.dead_letters.flush(5)
        self.consumer.close()
`;

  const serviceBusPy = `"""Azure Service Bus (official SDK, AMQP): topics for the exchange and the DLX, subscriptions for the queue and
the DLQ. Auth: SERVICEBUS_CONNECTION_STRING (shared access key; the emulator) or SERVICEBUS_NAMESPACE
(e.g. orders.servicebus.windows.net) with Microsoft Entra ID (managed identity in Container Apps / AKS).
A failed message is dead-lettered by the consumer: sent to the DLX topic, then completed.
Each publisher / subscription has its own client (the sync clients are not thread-safe)."""
from __future__ import annotations

import os
from typing import Optional

from azure.core.exceptions import ResourceExistsError
from azure.identity import DefaultAzureCredential
from azure.servicebus import ServiceBusClient, ServiceBusMessage, ServiceBusReceiveMode
from azure.servicebus.management import ServiceBusAdministrationClient

from .broker import Broker, BrokerMessage, Delivery, EventPublisher, EventSubscription, Topology


def _text(value) -> Optional[str]:
    if value is None:
        return None
    return value.decode() if isinstance(value, bytes) else str(value)


def _to_message(m: BrokerMessage) -> ServiceBusMessage:
    props = {}
    if m.tenant_id:
        props["tenant_id"] = m.tenant_id
    if m.traceparent:
        props["ghk_traceparent"] = m.traceparent
    return ServiceBusMessage(m.body, message_id=m.message_id, content_type="application/json", subject=m.event_type, application_properties=props)


class ServiceBusBroker(Broker):
    system = "servicebus"

    def __init__(self, connection_string: Optional[str], namespace: Optional[str]) -> None:
        self.connection_string = connection_string or None
        self.namespace = namespace
        self.dynamic_topology = "UseDevelopmentEmulator=true" not in (self.connection_string or "")

    @classmethod
    def from_env(cls, env=os.environ) -> "ServiceBusBroker":
        if not env.get("SERVICEBUS_CONNECTION_STRING") and not env.get("SERVICEBUS_NAMESPACE"):
            raise RuntimeError("SERVICEBUS_CONNECTION_STRING or SERVICEBUS_NAMESPACE is not set")
        return cls(env.get("SERVICEBUS_CONNECTION_STRING"), env.get("SERVICEBUS_NAMESPACE"))

    def client(self) -> ServiceBusClient:
        if self.connection_string:
            return ServiceBusClient.from_connection_string(self.connection_string)
        return ServiceBusClient(self.namespace, DefaultAzureCredential())

    def declare(self, t: Topology) -> None:
        # The emulator only knows the entities of its Config.json; in Azure they usually come from Terraform.
        if not self.dynamic_topology:
            return
        admin = (ServiceBusAdministrationClient.from_connection_string(self.connection_string) if self.connection_string
                 else ServiceBusAdministrationClient(self.namespace, DefaultAzureCredential()))
        for create in (lambda: admin.create_topic(t.exchange), lambda: admin.create_topic(t.dlx),
                       lambda: admin.create_subscription(t.exchange, t.queue), lambda: admin.create_subscription(t.dlx, t.dlq)):
            try:
                create()
            except ResourceExistsError:
                pass

    def publisher(self, topic: str) -> EventPublisher:
        return _ServiceBusPublisher(self.client(), topic)

    def subscribe(self, subscription: str, t: Topology) -> EventSubscription:
        return _ServiceBusSubscription(self, subscription, t)


class _ServiceBusPublisher(EventPublisher):
    system = "servicebus"

    def __init__(self, client: ServiceBusClient, topic: str) -> None:
        self.client = client
        self.sender = client.get_topic_sender(topic)
        self.destination = topic

    def publish(self, m: BrokerMessage) -> None:
        self.sender.send_messages(_to_message(m))

    def close(self) -> None:
        self.sender.close()
        self.client.close()


class _ServiceBusSubscription(EventSubscription):
    system = "servicebus"

    def __init__(self, broker: ServiceBusBroker, subscription: str, t: Topology) -> None:
        self.client = broker.client()
        topic = t.dlx if subscription == t.dlq else t.exchange
        self.receiver = self.client.get_subscription_receiver(topic, subscription, receive_mode=ServiceBusReceiveMode.PEEK_LOCK)
        # Open the AMQP link now: otherwise the first receive_messages must open it within its short max_wait_time.
        self.receiver.__enter__()
        self.dead_letters = None
        self.source = subscription
        self.t = t

    def poll(self) -> Optional[Delivery]:
        received = self.receiver.receive_messages(max_message_count=1, max_wait_time=0.5)
        if not received:
            return None
        msg = received[0]
        props = {_text(k): v for k, v in (msg.application_properties or {}).items()}
        message = BrokerMessage(str(msg.message_id), _text(msg.subject), _text(props.get("tenant_id")), _text(props.get("ghk_traceparent")),
                                b"".join(msg.body))

        def dead_letter() -> None:
            if self.dead_letters is None:
                self.dead_letters = self.client.get_topic_sender(self.t.dlx)
            self.dead_letters.send_messages(_to_message(message))
            self.receiver.complete_message(msg)

        return Delivery(message, lambda: self.receiver.complete_message(msg), dead_letter)

    def close(self) -> None:
        if self.dead_letters is not None:
            self.dead_letters.close()
        self.receiver.__exit__(None, None, None)
        self.client.close()
`;

  const inbox = `"""Idempotent consumer with dead-lettering."""
from __future__ import annotations

import json
import time
from typing import Any, Callable, Dict

import psycopg
from opentelemetry.trace import SpanKind, Status, StatusCode

from .broker import Delivery, EventSubscription
from .schema import schema_name
from .telemetry import context_from, tracer

Handler = Callable[[Dict[str, Any], Dict[str, Any]], None]


class InboxConsumer:
    """The message id is recorded in ghk_inbox in the same transaction as the handler, so
    redeliveries are acknowledged without running the handler twice. A handler error dead-letters
    the message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered."""

    def __init__(self, dsn: str, subscription: EventSubscription, consumer_name: str, handler: Handler, schema: str = "public") -> None:
        self.dsn = dsn
        self.subscription = subscription
        self.consumer_name = consumer_name
        self.handler = handler
        self.s = schema_name(schema)

    def drain(self, idle_seconds: float = 1.0) -> int:
        """Processes messages until the source stays idle for idle_seconds. Returns how many were processed."""
        processed = 0
        idle_since = time.monotonic()
        while time.monotonic() - idle_since < idle_seconds:
            delivery = self.subscription.poll()
            if delivery is None:
                time.sleep(0.05)
                continue
            self.process(delivery)
            processed += 1
            idle_since = time.monotonic()
        return processed

    def process(self, delivery: Delivery) -> None:
        message = delivery.message
        source = self.subscription.source
        with tracer().start_as_current_span(f"{source} process", context=context_from(message.traceparent), kind=SpanKind.CONSUMER,
                                            attributes={"messaging.system": self.subscription.system, "messaging.destination.name": source,
                                                        "messaging.message.id": message.message_id}) as span:
            try:
                with psycopg.connect(self.dsn) as conn:
                    first = conn.execute(f"INSERT INTO {self.s}.ghk_inbox (consumer, message_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                         (self.consumer_name, message.message_id))
                    if first.rowcount == 1:
                        self.handler(json.loads(message.body), {"message_id": message.message_id, "tenant_id": message.tenant_id,
                                                                "event_type": message.event_type, "connection": conn})
                    conn.commit()
                delivery.ack()
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR))
                delivery.dead_letter()
`;

  const saga = `"""Orchestrated saga with persisted progress and reverse-order compensation."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional

import psycopg

from .schema import schema_name


@dataclass
class SagaStep:
    name: str
    action: Callable[[], None]
    compensate: Callable[[], None]


class SagaOrchestrator:
    def __init__(self, dsn: str, schema: str = "public") -> None:
        self.dsn = dsn
        self.s = schema_name(schema)

    def run(self, saga_id: str, tenant_id: str, steps: List[SagaStep]) -> str:
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f"INSERT INTO {self.s}.ghk_sagas (id, tenant_id, status) VALUES (%s, %s, 'RUNNING') ON CONFLICT (id) DO NOTHING", (saga_id, tenant_id))
            row = conn.execute(f"SELECT completed_steps FROM {self.s}.ghk_sagas WHERE id = %s AND tenant_id = %s", (saga_id, tenant_id)).fetchone()
            completed = row[0].split(",") if row and row[0] else []
            by_name = {step.name: step for step in steps}
            for step in steps:
                if step.name in completed:
                    continue
                try:
                    step.action()
                    completed.append(step.name)
                    self._save(conn, saga_id, "RUNNING", completed)
                except Exception:
                    self._save(conn, saga_id, "COMPENSATING", completed)
                    for name in reversed(list(completed)):
                        by_name[name].compensate()
                        completed.remove(name)
                        self._save(conn, saga_id, "COMPENSATING", completed)
                    self._save(conn, saga_id, "COMPENSATED", completed)
                    return "COMPENSATED"
            self._save(conn, saga_id, "COMPLETED", completed)
            return "COMPLETED"

    def status(self, saga_id: str) -> Optional[dict]:
        with psycopg.connect(self.dsn) as conn:
            row = conn.execute(f"SELECT status, completed_steps FROM {self.s}.ghk_sagas WHERE id = %s", (saga_id,)).fetchone()
        return {"status": row[0], "completed_steps": row[1].split(",") if row[1] else []} if row else None

    def _save(self, conn, saga_id: str, status: str, completed: List[str]) -> None:
        conn.execute(f"UPDATE {self.s}.ghk_sagas SET status = %s, completed_steps = %s, updated_at = now() WHERE id = %s",
                     (status, ",".join(completed), saga_id))
`;

  const init = `"""Runtime kernel: PostgreSQL + event broker + OpenTelemetry (docs/RUNTIME-KERNEL.md)."""
from .broker import (DEFAULT_TOPOLOGY, Broker, BrokerMessage, Delivery, EventPublisher, EventSubscription, Topology,
                     broker_configured, broker_kind, connect_broker, topology)
from .command_service import CommandResult, CommandService
from .inbox_consumer import InboxConsumer
from .outbox_relay import OutboxRelay
from .saga import SagaOrchestrator, SagaStep
from .schema import migrate, schema_name

__all__ = ["Broker", "BrokerMessage", "CommandResult", "CommandService", "DEFAULT_TOPOLOGY", "Delivery", "EventPublisher",
           "EventSubscription", "InboxConsumer", "OutboxRelay", "SagaOrchestrator", "SagaStep", "Topology", "broker_configured",
           "broker_kind", "connect_broker", "migrate", "schema_name", "topology"]
`;

  const first = m.commands[0];
  const spec = `"""Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and the selected broker
(GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST], servicebus).
Requires DATABASE_URL. Run with: pytest -m integration"""
import os
import threading
import time
import uuid

import psycopg
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from ${pkg}.domain import DomainValidationError
from ${pkg}.runtime import (BrokerMessage, CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, SagaStep, broker_configured,
                         connect_broker, migrate, topology)

pytestmark = pytest.mark.integration

DATABASE_URL = os.environ.get("DATABASE_URL")
COMMAND = ${pyStr(first.snake)}
EVENT = ${pyStr(first.event)}

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
trace.set_tracer_provider(_provider)


def uid() -> str:
    return uuid.uuid4().hex[:12]


@pytest.fixture(scope="module")
def broker():
    if not DATABASE_URL or not broker_configured():
        pytest.fail("Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).")
    b = connect_broker()
    yield b
    b.close()


@pytest.fixture
def schema(broker):
    name = f"it_{uid()}"
    migrate(DATABASE_URL, name)
    EXPORTER.clear()
    yield name
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")


def receive(broker, t, source: str, expected: int):
    """Receives and acknowledges messages until the expected number arrived and the source stays quiet for 0.5 s (10 s at most)."""
    out = []
    subscription = broker.subscribe(source, t)
    deadline = time.time() + 10
    quiet_since = time.time()
    try:
        while time.time() < deadline and (len(out) < expected or time.time() - quiet_since < 0.5):
            delivery = subscription.poll()
            if delivery is None:
                time.sleep(0.05)
                continue
            out.append(delivery.message)
            delivery.ack()
            quiet_since = time.time()
    finally:
        subscription.close()
    return out


@pytest.fixture
def t(broker, schema):
    # Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
    topo = topology(f"it-{uid()}") if broker.dynamic_topology else topology("it")
    broker.declare(topo)
    if not broker.dynamic_topology:
        receive(broker, topo, topo.queue, 0)
        receive(broker, topo, topo.dlq, 0)
    return topo


def count(schema: str, table: str, where: str = "true", params=()) -> int:
    with psycopg.connect(DATABASE_URL) as conn:
        return conn.execute(f"SELECT count(*) FROM {schema}.{table} WHERE {where}", params).fetchone()[0]


def test_it1_atomic_write_and_rollback(schema):
    service = CommandService(DATABASE_URL, schema)
    result = service.handle("t1", "agg-1", COMMAND)
    assert (result.status, result.event_type, result.version) == ("created", EVENT, 1)
    assert service.load("t1", "agg-1")["version"] == 1
    assert count(schema, "ghk_outbox", "aggregate_id = %s", ("agg-1",)) == 1
    with pytest.raises(DomainValidationError, match="Unknown command"):
        service.handle("t1", "agg-2", "no_such_command", idempotency_key="k-fail")
    assert service.load("t1", "agg-2") is None
    assert count(schema, "ghk_outbox", "aggregate_id = %s", ("agg-2",)) == 0
    assert count(schema, "ghk_idempotency", "key = %s", ("k-fail",)) == 0


def test_it2_concurrent_idempotent_requests(schema):
    service = CommandService(DATABASE_URL, schema)
    results = []
    threads = [threading.Thread(target=lambda: results.append(service.handle("t1", "agg-1", COMMAND, idempotency_key="key-1"))) for _ in range(5)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert count(schema, "ghk_outbox") == 1
    assert service.load("t1", "agg-1")["version"] == 1
    assert [r.status for r in results].count("created") == 1
    assert all((r.event_type, r.version) == (EVENT, 1) for r in results)


def test_it3_concurrent_relays_publish_exactly_once(broker, schema, t):
    service = CommandService(DATABASE_URL, schema)
    for i in range(20):
        service.handle("t1", f"agg-{i}", COMMAND)
    totals = {}

    def drain(worker: str):
        publisher = broker.publisher(t.exchange)
        relay = OutboxRelay(DATABASE_URL, publisher, schema)
        total = 0
        while True:
            n = relay.publish_batch(worker, 3)
            if n == 0:
                break
            total += n
        totals[worker] = total
        publisher.close()

    workers = [threading.Thread(target=drain, args=(w,)) for w in ("relay-a", "relay-b")]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert sum(totals.values()) == 20
    assert count(schema, "ghk_outbox", "published_at IS NULL") == 0
    received = receive(broker, t, t.queue, 20)
    assert len(received) == 20
    assert len({m.message_id for m in received}) == 20


def test_it4_tenant_isolation(schema):
    service = CommandService(DATABASE_URL, schema)
    service.handle("tenant-a", "shared-id", COMMAND)
    assert service.load("tenant-b", "shared-id") is None
    service.handle("tenant-b", "shared-id", COMMAND)
    assert service.load("tenant-a", "shared-id")["version"] == 1
    assert service.load("tenant-b", "shared-id")["version"] == 1
    assert count(schema, "ghk_outbox", "tenant_id = %s", ("tenant-a",)) == 1


def test_it5_saga_compensates_in_reverse_order(schema):
    saga = SagaOrchestrator(DATABASE_URL, schema)
    log = []

    def step(name, fail=False):
        def action():
            if fail:
                raise RuntimeError(f"{name} failed")
            log.append(f"do:{name}")
        return SagaStep(name, action, lambda: log.append(f"undo:{name}"))

    assert saga.run("saga-1", "t1", [step("reserve"), step("charge"), step("ship", fail=True)]) == "COMPENSATED"
    assert log == ["do:reserve", "do:charge", "undo:charge", "undo:reserve"]
    assert saga.status("saga-1") == {"status": "COMPENSATED", "completed_steps": []}
    assert saga.run("saga-2", "t1", [step("reserve"), step("charge")]) == "COMPLETED"


def test_it6_inbox_deduplicates_and_dead_letters(broker, schema, t):
    handled = []

    def handler(event, meta):
        if event.get("poison"):
            raise RuntimeError("cannot process")
        handled.append(meta["message_id"])

    publisher = broker.publisher(t.exchange)
    for message_id, body in (("m-1", '{"ok": true}'), ("m-1", '{"ok": true}'), ("m-poison", '{"poison": true}')):
        publisher.publish(BrokerMessage(message_id, "Test", "t1", None, body.encode()))
    publisher.close()
    subscription = broker.subscribe(t.queue, t)
    InboxConsumer(DATABASE_URL, subscription, "it-consumer", handler, schema).drain()
    subscription.close()
    assert handled == ["m-1"]
    assert count(schema, "ghk_inbox", "consumer = %s", ("it-consumer",)) == 1
    assert [m.message_id for m in receive(broker, t, t.dlq, 1)] == ["m-poison"]


def test_it7_trace_context_propagation(broker, schema, t):
    service = CommandService(DATABASE_URL, schema)
    service.handle("t1", "agg-1", COMMAND, traceparent=${pyStr(TEST_TRACEPARENT)})
    with psycopg.connect(DATABASE_URL) as db:
        assert ${pyStr(TEST_TRACE_ID)} in db.execute(f"SELECT traceparent FROM {schema}.ghk_outbox").fetchone()[0]
    publisher = broker.publisher(t.exchange)
    assert OutboxRelay(DATABASE_URL, publisher, schema).publish_batch("relay", 10) == 1
    publisher.close()
    received = []
    subscription = broker.subscribe(t.queue, t)
    InboxConsumer(DATABASE_URL, subscription, "trace-consumer", lambda event, meta: received.append(meta), schema).drain()
    subscription.close()
    assert len(received) == 1

    spans = EXPORTER.get_finished_spans()
    by_kind = {s.kind: s for s in spans}
    trace_id = format(by_kind[SpanKind.INTERNAL].context.trace_id, "032x")
    assert trace_id == ${pyStr(TEST_TRACE_ID)}
    assert format(by_kind[SpanKind.INTERNAL].parent.span_id, "016x") == ${pyStr(TEST_PARENT_SPAN_ID)}
    assert format(by_kind[SpanKind.PRODUCER].context.trace_id, "032x") == ${pyStr(TEST_TRACE_ID)}
    assert format(by_kind[SpanKind.CONSUMER].context.trace_id, "032x") == ${pyStr(TEST_TRACE_ID)}
    assert by_kind[SpanKind.CONSUMER].parent.span_id == by_kind[SpanKind.PRODUCER].context.span_id
`;

  return [
    { filename: `${pkg}/runtime/__init__.py`, content: init },
    { filename: `${pkg}/runtime/telemetry.py`, content: telemetry },
    { filename: `${pkg}/runtime/otel.py`, content: `"""OpenTelemetry export of the running service.

With OTEL_EXPORTER_OTLP_ENDPOINT set, spans go over OTLP/HTTP to that collector (service.name from
OTEL_SERVICE_NAME); without it nothing is exported and nothing connects."""
from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_provider: TracerProvider | None = None


def start_telemetry(service_name: str = ${pyStr(m.service || m.kebab)}) -> bool:
    global _provider
    if _provider is not None or not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    _provider = TracerProvider(resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME") or service_name}))
    _provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(_provider)
    return True


def stop_telemetry() -> None:
    """Flushes the pending spans (call on shutdown)."""
    if _provider is not None:
        _provider.shutdown()
` },
    { filename: `${pkg}/runtime/schema.py`, content: schema },
    { filename: `${pkg}/runtime/command_service.py`, content: commandService },
    { filename: `${pkg}/runtime/broker.py`, content: broker },
    ...(serviceBus ? [{ filename: `${pkg}/runtime/servicebus_broker.py`, content: serviceBusPy }] : []),
    ...(kafka ? [{ filename: `${pkg}/runtime/kafka_broker.py`, content: kafkaPy }] : []),
    { filename: `${pkg}/runtime/outbox_relay.py`, content: relay },
    { filename: `${pkg}/runtime/inbox_consumer.py`, content: inbox },
    { filename: `${pkg}/runtime/saga.py`, content: saga },
    { filename: 'tests/integration/__init__.py', content: '' },
    { filename: 'tests/integration/test_runtime.py', content: spec }
  ];
}
