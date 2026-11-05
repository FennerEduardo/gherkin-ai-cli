/* ==========================================================================
   gherkin-ai-cli - The Python runtime kernel on MongoDB 7.0 (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). FastAPI.

   Same design as the TypeScript kernel on MongoDB (typescript-mongo.ts):
     - runtime/db.py: one MongoClient (pymongo) per DATABASE_URL, and
       in_transaction(): a transaction run again on a transient error, a write
       conflict or a duplicate key from a concurrent insert (PostgreSQL's row
       locks wait for the other writer instead);
     - collections with the kernel's column names and unique indexes; a
       schema is a database ("public" is the one in DATABASE_URL);
     - the command service and the inbox in transactions; the outbox claimed
       one event at a time with an atomic find_one_and_update and a lease on
       the server's clock ($$NOW).
   The kernel's signatures (CommandService(dsn, schema), migrate(dsn), ...)
   are unchanged, so the application layer is too. SQLAlchemy has no MongoDB
   dialect: app/database.py keeps its local SQLite default for the generated
   models; the service's state is the kernel's, in MongoDB.
   ========================================================================== */

import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS } from './shared';

type File = { filename: string; content: string };

const DB_PY = `"""MongoDB for the runtime kernel (stack.kernelDatabase "mongodb"). Transactions need a replica set (one node is enough)."""
from __future__ import annotations

import threading
import time
from typing import Callable, Dict, Optional, TypeVar

from pymongo import MongoClient
from pymongo.client_session import ClientSession
from pymongo.errors import PyMongoError
from pymongo.read_concern import ReadConcern
from pymongo.uri_parser import parse_uri
from pymongo.write_concern import WriteConcern

T = TypeVar("T")

_clients: Dict[str, MongoClient] = {}
_lock = threading.Lock()

# WriteConflict, DuplicateKey (a concurrent insert of the same key), NoSuchTransaction.
_RETRYABLE = {112, 11000, 251}


def client(dsn: str) -> MongoClient:
    """One MongoClient per URL: it pools its connections and is thread-safe."""
    with _lock:
        found = _clients.get(dsn)
        if found is None:
            found = _clients[dsn] = MongoClient(dsn)
        return found


def database_of(dsn: Optional[str]) -> str:
    """The database in the URL path ("app" when it names none)."""
    try:
        return parse_uri(dsn or "").get("database") or "app"
    except Exception:
        return "app"


def _retryable(err: Exception) -> bool:
    return isinstance(err, PyMongoError) and (err.has_error_label("TransientTransactionError") or getattr(err, "code", None) in _RETRYABLE)


def _commit(session: ClientSession) -> None:
    for attempt in range(1, 6):
        try:
            session.commit_transaction()
            return
        except PyMongoError as err:
            if attempt < 5 and err.has_error_label("UnknownTransactionCommitResult"):
                continue
            raise


def in_transaction(dsn: str, work: Callable[[ClientSession], T], attempts: int = 60) -> T:
    """Runs work in a transaction (snapshot reads, majority writes). On a transient error, a write conflict or a
    duplicate key from a concurrent transaction the work runs again on fresh data: the concurrent writer has
    committed by then, as a PostgreSQL row lock would have waited for it. Other errors (a domain error) propagate."""
    attempt = 0
    while True:
        attempt += 1
        with client(dsn).start_session() as session:
            session.start_transaction(read_concern=ReadConcern("snapshot"), write_concern=WriteConcern("majority"))
            try:
                result = work(session)
                _commit(session)
                return result
            except Exception as err:
                if session.in_transaction:
                    try:
                        session.abort_transaction()
                    except PyMongoError:
                        pass
                if attempt < attempts and _retryable(err):
                    time.sleep(min(0.005 * attempt, 0.1))
                    continue
                raise
`;

const SCHEMA_PY = `"""The kernel's collections on MongoDB (docs/RUNTIME-KERNEL.md): a schema is a database."""
from __future__ import annotations

import os
import re
from typing import Optional

from pymongo import ASCENDING
from pymongo.errors import CollectionInvalid, OperationFailure

from .db import client, database_of

# Collections and their keys (unique indexes).
COLLECTIONS = {
    "ghk_aggregates": [("tenant_id", "aggregate_type", "id")],
    "ghk_outbox": [],
    "ghk_idempotency": [("tenant_id", "key")],
    "ghk_inbox": [("consumer", "message_id")],
    "ghk_sagas": [],
}

# Tenant isolation is the repository filter (tenant_id in every query).


def schema_name(schema: str = "public", dsn: Optional[str] = None) -> str:
    """Validated database name; "public" is the database of the DSN (or DATABASE_URL)."""
    s = database_of(dsn or os.environ.get("DATABASE_URL")) if not schema or schema == "public" else schema
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", s):
        raise ValueError(f"Invalid schema name: {s}")
    return s


def migrate(dsn: str, schema: str = "public") -> None:
    """Creates the collections and indexes (idempotent); they exist before any transaction writes to them."""
    db = client(dsn)[schema_name(schema, dsn)]
    existing = set(db.list_collection_names())
    for name, keys in COLLECTIONS.items():
        if name not in existing:
            try:
                db.create_collection(name)
            except (CollectionInvalid, OperationFailure):
                pass  # created by a replica starting at the same time
        for key in keys:
            db[name].create_index([(field, ASCENDING) for field in key], unique=True)
    db["ghk_outbox"].create_index([("published_at", ASCENDING), ("failed_at", ASCENDING), ("created_at", ASCENDING)])
`;

const COMMAND_SERVICE_CLASS = `class CommandService:
    def __init__(self, dsn: str, schema: str = "public") -> None:
        self.dsn = dsn
        self.s = schema_name(schema, dsn)

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
                ctx = trace.set_span_in_context(span, parent)
                # A concurrent change of the same aggregate is a write conflict: the transaction runs again on its result.
                return in_transaction(self.dsn, lambda session: self._handle(session, aggregate_type, tenant_id, aggregate_id, command, payload or {}, idempotency_key, ctx))
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR, str(err)))
                raise

    def _handle(self, session, aggregate_type, tenant_id, aggregate_id, command, payload, key, ctx) -> CommandResult:
        cls, state_cls, command_cls, commands = AGGREGATES[aggregate_type]
        db = client(self.dsn)[self.s]
        if key:
            claim = {"tenant_id": tenant_id, "key": key}
            done = db.ghk_idempotency.find_one(claim, session=session)
            if done:
                if done["status"] == "COMPLETED":
                    return CommandResult(**{**json.loads(done["response"]), "status": "replayed"})
                return CommandResult("in-progress", aggregate_id)
            db.ghk_idempotency.insert_one({**claim, "status": "PROCESSING", "created_at": datetime.now(timezone.utc)}, session=session)
        ident = {"tenant_id": tenant_id, "aggregate_type": aggregate_type, "id": aggregate_id}
        row = db.ghk_aggregates.find_one(ident, session=session)
        aggregate = cls.restore(aggregate_id, state_cls(row["state"]), int(row["version"])) if row else cls(aggregate_id)
        handler = commands.get(command)
        if handler is None:
            raise DomainValidationError(f"Unknown command {command}")
        event = handler(aggregate, command_cls(aggregate_id, payload))
        now = datetime.now(timezone.utc)
        db.ghk_aggregates.update_one(ident, {"$set": {"state": aggregate.state.value, "version": aggregate.version, "updated_at": now}}, upsert=True, session=session)
        db.ghk_outbox.insert_one({
            "_id": str(uuid.uuid4()), "tenant_id": tenant_id, "aggregate_id": aggregate_id, "event_type": event.type.value,
            "payload": _event_json(event), "traceparent": traceparent_of(ctx), "created_at": now, "claimed_by": None,
            "claimed_until": None, "published_at": None, "attempts": 0, "last_error": None, "failed_at": None,
        }, session=session)
        result = CommandResult("created", aggregate_id, event.type.value, event.version)
        if key:
            db.ghk_idempotency.update_one({"tenant_id": tenant_id, "key": key}, {"$set": {"status": "COMPLETED", "response": json.dumps(asdict(result))}}, session=session)
        return result

    def load(self, tenant_id: str, aggregate_id: str, aggregate_type: str = DEFAULT_AGGREGATE) -> Optional[Dict[str, Any]]:
        """The aggregate as tenant \`tenant_id\` sees it (None for other tenants' aggregates)."""
        row = client(self.dsn)[self.s].ghk_aggregates.find_one({"tenant_id": tenant_id, "aggregate_type": aggregate_type, "id": aggregate_id})
        return {"state": row["state"], "version": int(row["version"])} if row else None
`;

const RELAY_PY = `"""Outbox relay."""
from __future__ import annotations

from typing import Any, Dict, Optional

from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode
from pymongo import ReturnDocument

from .broker import BrokerMessage, EventPublisher
from .db import client
from .schema import schema_name
from .telemetry import context_from, traceparent_of, tracer


class OutboxRelay:
    """Publishes pending outbox events. Each one is claimed with an atomic find_one_and_update and a lease on the
    server's clock, so concurrent relays never publish the same event; the publisher returns only once the broker
    has accepted the message, before it is marked published. Use one relay (and publisher) per thread."""

    def __init__(self, dsn: str, publisher: EventPublisher, schema: str = "public",
                 lease_seconds: int = ${LEASE_SECONDS}, max_attempts: int = ${MAX_PUBLISH_ATTEMPTS}) -> None:
        self.dsn = dsn
        self.publisher = publisher
        self.s = schema_name(schema, dsn)
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts

    def _claim(self, outbox, worker_id: str) -> Optional[Dict[str, Any]]:
        """The oldest pending event nobody holds a lease on, leased to worker_id."""
        return outbox.find_one_and_update(
            {"published_at": None, "failed_at": None, "$or": [{"claimed_until": None}, {"$expr": {"$lt": ["$claimed_until", "$$NOW"]}}]},
            [{"$set": {"claimed_by": {"$literal": worker_id}, "claimed_until": {"$add": ["$$NOW", self.lease_seconds * 1000]},
                       "attempts": {"$add": ["$attempts", 1]}}}],
            sort=[("created_at", 1), ("_id", 1)], return_document=ReturnDocument.AFTER)

    def publish_batch(self, worker_id: str, limit: int = 50) -> int:
        outbox = client(self.dsn)[self.s].ghk_outbox
        published = 0
        for _ in range(limit):
            row = self._claim(outbox, worker_id)
            if row is None:
                break
            parent = context_from(row.get("traceparent"))
            destination = self.publisher.destination
            with tracer().start_as_current_span(f"{destination} publish", context=parent, kind=SpanKind.PRODUCER,
                                                attributes={"messaging.system": self.publisher.system, "messaging.destination.name": destination,
                                                            "messaging.message.id": row["_id"], "tenant.id": row["tenant_id"]}) as span:
                try:
                    tp = traceparent_of(trace.set_span_in_context(span, parent))
                    self.publisher.publish(BrokerMessage(row["_id"], row["event_type"], row["tenant_id"], tp, row["payload"].encode("utf-8")))
                    outbox.update_one({"_id": row["_id"], "claimed_by": worker_id}, [{"$set": {"published_at": "$$NOW", "claimed_until": None}}])
                    published += 1
                except Exception as err:  # broker unavailable / nacked: release the lease, retry later
                    span.record_exception(err)
                    span.set_status(Status(StatusCode.ERROR))
                    outbox.update_one({"_id": row["_id"]}, [{"$set": {
                        "claimed_until": None,
                        "last_error": {"$literal": str(err)},
                        "failed_at": {"$cond": [{"$gte": ["$attempts", self.max_attempts]}, "$$NOW", None]},
                    }}])
        return published
`;

const INBOX_PY = `"""Idempotent inbox consumer."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict

from opentelemetry.trace import SpanKind, Status, StatusCode

from .broker import Delivery, EventSubscription
from .db import client, in_transaction
from .schema import schema_name
from .telemetry import context_from, tracer

Handler = Callable[[Dict[str, Any], Dict[str, Any]], None]


class InboxConsumer:
    """The message id is recorded in ghk_inbox in the same transaction as the handler, so redeliveries are
    acknowledged without running the handler twice. A handler error dead-letters the message: it is not redelivered.
    A write conflict runs the transaction (and the handler) again: keep the handler's effects in meta["session"]."""

    def __init__(self, dsn: str, subscription: EventSubscription, consumer_name: str, handler: Handler, schema: str = "public") -> None:
        self.dsn = dsn
        self.subscription = subscription
        self.consumer_name = consumer_name
        self.handler = handler
        self.s = schema_name(schema, dsn)

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
        db = client(self.dsn)[self.s]

        def record_and_handle(session) -> None:
            key = {"consumer": self.consumer_name, "message_id": message.message_id}
            if db.ghk_inbox.find_one(key, session=session):
                return
            db.ghk_inbox.insert_one({**key, "processed_at": datetime.now(timezone.utc)}, session=session)
            self.handler(json.loads(message.body), {"message_id": message.message_id, "tenant_id": message.tenant_id,
                                                    "event_type": message.event_type, "session": session, "database": db})

        with tracer().start_as_current_span(f"{source} process", context=context_from(message.traceparent), kind=SpanKind.CONSUMER,
                                            attributes={"messaging.system": self.subscription.system, "messaging.destination.name": source,
                                                        "messaging.message.id": message.message_id}) as span:
            try:
                in_transaction(self.dsn, record_and_handle)
                delivery.ack()
            except Exception as err:
                span.record_exception(err)
                span.set_status(Status(StatusCode.ERROR))
                delivery.dead_letter()
`;

const SAGA_PY = `"""Orchestrated saga with persisted progress and reverse-order compensation."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, List, Optional

from pymongo.errors import DuplicateKeyError

from .db import client
from .schema import schema_name


@dataclass
class SagaStep:
    name: str
    action: Callable[[], None]
    compensate: Callable[[], None]


class SagaOrchestrator:
    def __init__(self, dsn: str, schema: str = "public") -> None:
        self.dsn = dsn
        self.s = schema_name(schema, dsn)

    @property
    def _sagas(self):
        return client(self.dsn)[self.s].ghk_sagas

    def run(self, saga_id: str, tenant_id: str, steps: List[SagaStep]) -> str:
        try:
            self._sagas.update_one({"_id": saga_id}, {"$setOnInsert": {"tenant_id": tenant_id, "status": "RUNNING", "completed_steps": "",
                                                                       "updated_at": datetime.now(timezone.utc)}}, upsert=True)
        except DuplicateKeyError:
            pass  # a concurrent run created it
        row = self._sagas.find_one({"_id": saga_id, "tenant_id": tenant_id})
        completed = row["completed_steps"].split(",") if row and row["completed_steps"] else []
        by_name = {step.name: step for step in steps}
        for step in steps:
            if step.name in completed:
                continue
            try:
                step.action()
                completed.append(step.name)
                self._save(saga_id, "RUNNING", completed)
            except Exception:
                self._save(saga_id, "COMPENSATING", completed)
                for name in reversed(list(completed)):
                    by_name[name].compensate()
                    completed.remove(name)
                    self._save(saga_id, "COMPENSATING", completed)
                self._save(saga_id, "COMPENSATED", completed)
                return "COMPENSATED"
        self._save(saga_id, "COMPLETED", completed)
        return "COMPLETED"

    def status(self, saga_id: str) -> Optional[dict]:
        row = self._sagas.find_one({"_id": saga_id})
        return {"status": row["status"], "completed_steps": row["completed_steps"].split(",") if row["completed_steps"] else []} if row else None

    def _save(self, saga_id: str, status: str, completed: List[str]) -> None:
        self._sagas.update_one({"_id": saga_id}, {"$set": {"status": status, "completed_steps": ",".join(completed), "updated_at": datetime.now(timezone.utc)}})
`;

/** [PostgreSQL text, MongoDB text] pairs in the files that are kept (tests, pyproject, app/database.py). */
const STATEMENTS: [RegExp | string, string | ((...m: string[]) => string)][] = [
  // Runtime integration tests.
  [/def count\(schema: str, table: str, where: str = "true", params=\(\)\) -> int:\n {4}with psycopg\.connect\(DATABASE_URL\) as conn:\n {8}return conn\.execute\([^\n]*\n/,
    'def count(schema: str, collection: str, query=None) -> int:\n    return kernel_db.client(DATABASE_URL)[schema][collection].count_documents(query or {})\n'],
  [/count\(schema, "(\w+)", "(\w+) = %s", \(([^,()]+),\)\)/g, 'count(schema, "$1", {"$2": $3})'],
  [/count\(schema, "(\w+)", "(\w+) IS NULL"\)/g, 'count(schema, "$1", {"$2": None})'],
  [/ {4}with psycopg\.connect\(DATABASE_URL, autocommit=True\) as conn:\n {8}conn\.execute\(f"DROP SCHEMA IF EXISTS \{name\} CASCADE"\)/, '    kernel_db.client(DATABASE_URL).drop_database(name)'],
  [/ {4}with psycopg\.connect\(DATABASE_URL\) as db:\n {8}assert ("[^"]*") in db\.execute\(f"SELECT traceparent FROM \{schema\}\.ghk_outbox"\)\.fetchone\(\)\[0\]/,
    (_m: string, id: string) => `    assert ${id} in kernel_db.client(DATABASE_URL)[schema].ghk_outbox.find_one()["traceparent"]`],
  // HTTP integration tests.
  [/ {4}with psycopg\.connect\(DSN\) as conn:\n {8}rows = conn\.execute\("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = %s", \(aggregate_id,\)\)\.fetchall\(\)/,
    '    rows = [(d["tenant_id"],) for d in kernel_db.client(DSN)[kernel_db.database_of(DSN)].ghk_outbox.find({"aggregate_id": aggregate_id})]'],
  ['against PostgreSQL and RabbitMQ', 'against MongoDB and RabbitMQ'],
  ['"""Runtime kernel: PostgreSQL + event broker', '"""Runtime kernel: MongoDB + event broker'],
  ['against PostgreSQL and the selected broker', 'against MongoDB and the selected broker'],
  ['HTTP contract of the application layer against PostgreSQL', 'HTTP contract of the application layer against MongoDB'],
  // pyproject.toml
  ['"psycopg[binary]>=3.2",', '"pymongo>=4.10",'],
  // app/database.py: SQLAlchemy has no MongoDB dialect.
  ['# libpq-style URLs (postgres://, postgresql://) use the psycopg 3 driver.\nfor prefix in ("postgres://", "postgresql://"):\n    if DATABASE_URL.startswith(prefix):\n        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(prefix):]',
    '# The runtime kernel keeps the service\'s state in MongoDB (stack.kernelDatabase "mongodb"); SQLAlchemy has no\n# MongoDB dialect, so the generated models keep a local SQLite database.\nif DATABASE_URL.startswith("mongodb"):\n    DATABASE_URL = "sqlite:///./app.db"']
];

/** Adapts a generated FastAPI project (PostgreSQL kernel) to MongoDB. */
export function mongoizePyProject(files: File[]): File[] {
  const schemaFile = files.find(f => /(^|\/)runtime\/schema\.py$/.test(f.filename));
  if (!schemaFile) return files;
  const runtimeDir = schemaFile.filename.replace(/schema\.py$/, '');
  const runtimePkg = runtimeDir.replace(/\/$/, '').replace(/\//g, '.');
  const out = files.map(f => {
    switch (f.filename.slice(runtimeDir.length)) {
      case 'schema.py': if (f.filename.startsWith(runtimeDir)) return { ...f, content: SCHEMA_PY }; break;
      case 'outbox_relay.py': if (f.filename.startsWith(runtimeDir)) return { ...f, content: RELAY_PY }; break;
      case 'inbox_consumer.py': if (f.filename.startsWith(runtimeDir)) return { ...f, content: INBOX_PY }; break;
      case 'saga.py': if (f.filename.startsWith(runtimeDir)) return { ...f, content: SAGA_PY }; break;
      case 'command_service.py': if (f.filename.startsWith(runtimeDir)) return { ...f, content: commandService(f.content) }; break;
    }
    if (!/\.(py|toml)$/.test(f.filename)) return f;
    let content = f.content.replace(/^import psycopg$/m, `from ${runtimePkg} import db as kernel_db`);
    for (const [pg, mongo] of STATEMENTS) {
      content = typeof pg === 'string' ? content.split(pg).join(mongo as string) : content.replace(pg, mongo as (...m: string[]) => string);
    }
    return { ...f, content };
  });
  return [...out, { filename: `${runtimeDir}db.py`, content: DB_PY }];
}

/** Keeps the generated aggregate table and result type; replaces the class and the psycopg import. */
function commandService(content: string): string {
  return content
    .replace(/^import psycopg$/m, 'from datetime import datetime, timezone')
    .replace('from .schema import schema_name', 'from .db import client, in_transaction\nfrom .schema import schema_name')
    .replace(/"""Executes commands in one transaction: idempotency claim, aggregate load \(FOR UPDATE\),\ndomain logic, aggregate save and outbox insert\. A domain error rolls everything back\."""/,
      '"""Executes commands in one MongoDB transaction: idempotency lookup, aggregate load, domain logic, aggregate save\nand outbox insert. A domain error aborts everything; a concurrent writer makes it run again."""')
    .replace(/^class CommandService:[\s\S]*$/m, () => COMMAND_SERVICE_CLASS);
}
