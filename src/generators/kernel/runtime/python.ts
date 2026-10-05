/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for Python (FastAPI, Django)
   psycopg 3 + pika + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface PyRuntimeFile {
  filename: string;
  content: string;
}

export const PY_RUNTIME_DEPENDENCIES = ['psycopg[binary]>=3.2', 'pika>=1.3', 'opentelemetry-api>=1.27', 'opentelemetry-sdk>=1.27'];

/** pytest ini lines registering the marker the integration suite uses. */
export const PY_INTEGRATION_MARKER = 'markers = ["integration: runtime tests against PostgreSQL and RabbitMQ (DATABASE_URL, AMQP_URL)"]';

const pyStr = (s: string) => JSON.stringify(s);

export function renderPyRuntime(m: DomainModel, pkg = 'app'): PyRuntimeFile[] {
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

from ${pkg}.domain import ${A}, ${m.pascal}Command, ${m.pascal}DomainEvent, ${m.pascal}State, DomainValidationError
from .schema import schema_name
from .telemetry import context_from, traceparent_of, tracer

AGGREGATE_TYPE = ${pyStr(m.pascal)}

COMMANDS: Dict[str, Callable[[${A}, ${m.pascal}Command], ${m.pascal}DomainEvent]] = {
${m.commands.map(c => `    ${pyStr(c.snake)}: lambda a, c: a.${c.snake}(c),`).join('\n')}
}


@dataclass
class CommandResult:
    status: str
    aggregate_id: str
    event_type: Optional[str] = None
    version: Optional[int] = None


def _event_json(event: ${m.pascal}DomainEvent) -> str:
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
               idempotency_key: Optional[str] = None, traceparent: Optional[str] = None) -> CommandResult:
        if not tenant_id:
            raise DomainValidationError("tenant_id is required")
        parent = context_from(traceparent)
        with tracer().start_as_current_span(f"${m.pascal}.{command}", context=parent, kind=SpanKind.INTERNAL,
                                            attributes={"tenant.id": tenant_id, "aggregate.id": aggregate_id}) as span:
            try:
                return self._handle(tenant_id, aggregate_id, command, payload or {}, idempotency_key, trace.set_span_in_context(span, parent))
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR, str(err)))
                raise

    def _handle(self, tenant_id, aggregate_id, command, payload, key, ctx) -> CommandResult:
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
                               (tenant_id, AGGREGATE_TYPE, aggregate_id)).fetchone()
            aggregate = ${A}.restore(aggregate_id, ${m.pascal}State(row[0]), int(row[1])) if row else ${A}(aggregate_id)
            handler = COMMANDS.get(command)
            if handler is None:
                raise DomainValidationError(f"Unknown command {command}")
            event = handler(aggregate, ${m.pascal}Command(aggregate_id, payload))
            conn.execute(
                f"INSERT INTO {s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (%s, %s, %s, %s, %s) "
                f"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
                (tenant_id, AGGREGATE_TYPE, aggregate_id, aggregate.state.value, aggregate.version))
            conn.execute(
                f"INSERT INTO {s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (%s, %s, %s, %s, %s, %s)",
                (str(uuid.uuid4()), tenant_id, aggregate_id, event.type.value, _event_json(event), traceparent_of(ctx)))
            result = CommandResult("created", aggregate_id, event.type.value, event.version)
            if key:
                conn.execute(f"UPDATE {s}.ghk_idempotency SET status = 'COMPLETED', response = %s WHERE tenant_id = %s AND key = %s",
                             (json.dumps(asdict(result)), tenant_id, key))
            conn.commit()
            return result

    def load(self, tenant_id: str, aggregate_id: str) -> Optional[Dict[str, Any]]:
        """The aggregate as tenant \`tenant_id\` sees it (None for other tenants' aggregates)."""
        with psycopg.connect(self.dsn) as conn:
            row = conn.execute(f"SELECT state, version FROM {self.s}.ghk_aggregates WHERE tenant_id = %s AND aggregate_type = %s AND id = %s",
                               (tenant_id, AGGREGATE_TYPE, aggregate_id)).fetchone()
        return {"state": row[0], "version": int(row[1])} if row else None
`;

  const relay = `"""Outbox relay and RabbitMQ topology."""
from __future__ import annotations

from dataclasses import dataclass

import pika
import psycopg
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .schema import schema_name
from .telemetry import context_from, traceparent_of, tracer


@dataclass(frozen=True)
class Topology:
    exchange: str
    queue: str
    dlx: str
    dlq: str


def topology(prefix: str = ${pyStr(m.kebab)}) -> Topology:
    return Topology(f"{prefix}.events", f"{prefix}.consumer", f"{prefix}.dlx", f"{prefix}.dlq")


DEFAULT_TOPOLOGY = Topology(${pyStr(t.exchange)}, ${pyStr(t.queue)}, ${pyStr(t.dlx)}, ${pyStr(t.dlq)})


def declare_topology(channel, t: Topology = DEFAULT_TOPOLOGY) -> None:
    """Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ."""
    channel.exchange_declare(exchange=t.exchange, exchange_type="topic", durable=True)
    channel.exchange_declare(exchange=t.dlx, exchange_type="fanout", durable=True)
    channel.queue_declare(queue=t.dlq, durable=True)
    channel.queue_bind(queue=t.dlq, exchange=t.dlx, routing_key="")
    channel.queue_declare(queue=t.queue, durable=True, arguments={"x-dead-letter-exchange": t.dlx})
    channel.queue_bind(queue=t.queue, exchange=t.exchange, routing_key="#")


class OutboxRelay:
    """Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
    concurrent relays never publish the same row; publisher confirms guarantee delivery to the
    broker before a row is marked published. Use one relay (and channel) per thread."""

    def __init__(self, dsn: str, channel, exchange: str = DEFAULT_TOPOLOGY.exchange, schema: str = "public",
                 lease_seconds: int = ${LEASE_SECONDS}, max_attempts: int = ${MAX_PUBLISH_ATTEMPTS}) -> None:
        self.dsn = dsn
        self.channel = channel
        self.channel.confirm_delivery()
        self.exchange = exchange
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
                with tracer().start_as_current_span(f"{self.exchange} publish", context=parent, kind=SpanKind.PRODUCER,
                                                    attributes={"messaging.system": "rabbitmq", "messaging.destination.name": self.exchange,
                                                                "messaging.message.id": id_, "tenant.id": tenant_id}) as span:
                    try:
                        headers = {"tenant_id": tenant_id}
                        tp = traceparent_of(trace.set_span_in_context(span, parent))
                        if tp:
                            headers["traceparent"] = tp
                        self.channel.basic_publish(
                            exchange=self.exchange, routing_key=event_type, body=payload.encode("utf-8"),
                            properties=pika.BasicProperties(message_id=id_, delivery_mode=2, content_type="application/json",
                                                            type=event_type, headers=headers),
                            mandatory=False)
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

  const inbox = `"""Idempotent consumer with dead-lettering."""
from __future__ import annotations

import json
from typing import Any, Callable, Dict

import psycopg
from opentelemetry.trace import SpanKind, Status, StatusCode

from .schema import schema_name
from .telemetry import context_from, tracer

Handler = Callable[[Dict[str, Any], Dict[str, Any]], None]


class InboxConsumer:
    """The message id is recorded in ghk_inbox in the same transaction as the handler, so
    redeliveries are acknowledged without running the handler twice. A handler error rejects the
    message without requeue, so RabbitMQ dead-letters it to the DLQ."""

    def __init__(self, dsn: str, channel, queue: str, consumer_name: str, handler: Handler, schema: str = "public") -> None:
        self.dsn = dsn
        self.channel = channel
        self.queue = queue
        self.consumer_name = consumer_name
        self.handler = handler
        self.s = schema_name(schema)

    def drain(self, idle_seconds: float = 1.0) -> int:
        """Processes messages until the queue stays idle for idle_seconds. Returns how many were processed."""
        processed = 0
        for method, properties, body in self.channel.consume(self.queue, inactivity_timeout=idle_seconds):
            if method is None:
                break
            self.on_message(method, properties, body)
            processed += 1
        self.channel.cancel()
        return processed

    def on_message(self, method, properties, body: bytes) -> None:
        headers = properties.headers or {}
        message_id = str(properties.message_id)
        with tracer().start_as_current_span(f"{self.queue} process", context=context_from(headers.get("traceparent")), kind=SpanKind.CONSUMER,
                                            attributes={"messaging.system": "rabbitmq", "messaging.destination.name": self.queue,
                                                        "messaging.message.id": message_id}) as span:
            try:
                with psycopg.connect(self.dsn) as conn:
                    first = conn.execute(f"INSERT INTO {self.s}.ghk_inbox (consumer, message_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                         (self.consumer_name, message_id))
                    if first.rowcount == 1:
                        self.handler(json.loads(body), {"message_id": message_id, "tenant_id": headers.get("tenant_id"),
                                                        "event_type": properties.type, "connection": conn})
                    conn.commit()
                self.channel.basic_ack(method.delivery_tag)
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR))
                self.channel.basic_nack(method.delivery_tag, requeue=False)
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

  const init = `"""Runtime kernel: PostgreSQL + RabbitMQ + OpenTelemetry (docs/RUNTIME-KERNEL.md)."""
from .command_service import CommandResult, CommandService
from .inbox_consumer import InboxConsumer
from .outbox_relay import DEFAULT_TOPOLOGY, OutboxRelay, Topology, declare_topology, topology
from .saga import SagaOrchestrator, SagaStep
from .schema import migrate, schema_name

__all__ = ["CommandResult", "CommandService", "InboxConsumer", "OutboxRelay", "Topology", "DEFAULT_TOPOLOGY",
           "declare_topology", "topology", "SagaOrchestrator", "SagaStep", "migrate", "schema_name"]
`;

  const first = m.commands[0];
  const spec = `"""Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
Requires DATABASE_URL and AMQP_URL. Run with: pytest -m integration"""
import os
import threading
import time
import uuid

import pika
import psycopg
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from ${pkg}.domain import DomainValidationError
from ${pkg}.runtime import CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, SagaStep, declare_topology, migrate, topology

pytestmark = pytest.mark.integration

DATABASE_URL = os.environ.get("DATABASE_URL")
AMQP_URL = os.environ.get("AMQP_URL")
COMMAND = ${pyStr(first.snake)}
EVENT = ${pyStr(first.event)}

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
trace.set_tracer_provider(_provider)


def uid() -> str:
    return uuid.uuid4().hex[:12]


@pytest.fixture
def schema():
    if not DATABASE_URL or not AMQP_URL:
        pytest.fail("Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).")
    name = f"it_{uid()}"
    migrate(DATABASE_URL, name)
    EXPORTER.clear()
    yield name
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {name} CASCADE")


@pytest.fixture
def t():
    return topology(f"it-{uid()}")


def channel():
    connection = pika.BlockingConnection(pika.URLParameters(AMQP_URL))
    return connection, connection.channel()


def count(schema: str, table: str, where: str = "true", params=()) -> int:
    with psycopg.connect(DATABASE_URL) as conn:
        return conn.execute(f"SELECT count(*) FROM {schema}.{table} WHERE {where}", params).fetchone()[0]


def drain_queue(ch, queue: str):
    messages = []
    while True:
        method, properties, body = ch.basic_get(queue, auto_ack=True)
        if method is None:
            return messages
        messages.append(properties)


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


def test_it3_concurrent_relays_publish_exactly_once(schema, t):
    service = CommandService(DATABASE_URL, schema)
    for i in range(20):
        service.handle("t1", f"agg-{i}", COMMAND)
    setup_conn, setup = channel()
    declare_topology(setup, t)
    totals = {}

    def drain(worker: str):
        conn, ch = channel()
        relay = OutboxRelay(DATABASE_URL, ch, t.exchange, schema)
        total = 0
        while True:
            n = relay.publish_batch(worker, 3)
            if n == 0:
                break
            total += n
        totals[worker] = total
        conn.close()

    workers = [threading.Thread(target=drain, args=(w,)) for w in ("relay-a", "relay-b")]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert sum(totals.values()) == 20
    assert count(schema, "ghk_outbox", "published_at IS NULL") == 0
    deadline = time.time() + 10
    while setup.queue_declare(queue=t.queue, passive=True).method.message_count < 20 and time.time() < deadline:
        time.sleep(0.05)
    ids = [p.message_id for p in drain_queue(setup, t.queue)]
    assert len(set(ids)) == 20
    setup_conn.close()


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


def test_it6_inbox_deduplicates_and_dead_letters(schema, t):
    conn, ch = channel()
    declare_topology(ch, t)
    handled = []

    def handler(event, meta):
        if event.get("poison"):
            raise RuntimeError("cannot process")
        handled.append(meta["message_id"])

    def publish(message_id, body):
        ch.basic_publish(t.exchange, "Test", body.encode(), pika.BasicProperties(message_id=message_id, headers={"tenant_id": "t1"}))

    publish("m-1", '{"ok": true}')
    publish("m-1", '{"ok": true}')
    publish("m-poison", '{"poison": true}')
    InboxConsumer(DATABASE_URL, ch, t.queue, "it-consumer", handler, schema).drain()
    assert handled == ["m-1"]
    assert count(schema, "ghk_inbox", "consumer = %s", ("it-consumer",)) == 1
    deadline = time.time() + 10
    while ch.queue_declare(queue=t.dlq, passive=True).method.message_count < 1 and time.time() < deadline:
        time.sleep(0.05)
    assert [p.message_id for p in drain_queue(ch, t.dlq)] == ["m-poison"]
    conn.close()


def test_it7_trace_context_propagation(schema, t):
    service = CommandService(DATABASE_URL, schema)
    service.handle("t1", "agg-1", COMMAND, traceparent=${pyStr(TEST_TRACEPARENT)})
    with psycopg.connect(DATABASE_URL) as db:
        assert ${pyStr(TEST_TRACE_ID)} in db.execute(f"SELECT traceparent FROM {schema}.ghk_outbox").fetchone()[0]
    conn, ch = channel()
    declare_topology(ch, t)
    assert OutboxRelay(DATABASE_URL, ch, t.exchange, schema).publish_batch("relay", 10) == 1
    received = []
    InboxConsumer(DATABASE_URL, ch, t.queue, "trace-consumer", lambda event, meta: received.append(meta), schema).drain()
    conn.close()
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
    { filename: `${pkg}/runtime/schema.py`, content: schema },
    { filename: `${pkg}/runtime/command_service.py`, content: commandService },
    { filename: `${pkg}/runtime/outbox_relay.py`, content: relay },
    { filename: `${pkg}/runtime/inbox_consumer.py`, content: inbox },
    { filename: `${pkg}/runtime/saga.py`, content: saga },
    { filename: 'tests/integration/__init__.py', content: '' },
    { filename: 'tests/integration/test_runtime.py', content: spec }
  ];
}
