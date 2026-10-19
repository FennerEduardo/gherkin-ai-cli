/* ==========================================================================
   gherkin-ai-cli - Application layer for FastAPI and Django over the Python
   runtime kernel: JWT tenant, CommandService from DATABASE_URL, outbox relay
   worker thread, HTTP endpoint and tests. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface PyAppFile {
  filename: string;
  content: string;
}

const py = (s: string) => JSON.stringify(s);
const TEST_SECRET = 'integration-test-secret-with-32-chars!';

/** HS256 JWT verification without dependencies. */
export function renderPyAuth(claim: string): string {
  return `"""Bearer tokens (HS256, JWT_SECRET). The tenant comes only from the ${py(claim)} claim of a validated
token, never from a header such as X-Tenant-Id, and there is no default tenant."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict, Optional

TENANT_CLAIM = ${py(claim)}


def _b64decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def verify_jwt(token: str, secret: str) -> Optional[Dict[str, Any]]:
    """Claims of a valid HS256 token (signature, exp and nbf checked), else None."""
    parts = token.split(".")
    if len(parts) != 3 or not secret:
        return None
    try:
        if json.loads(_b64decode(parts[0])).get("alg") != "HS256":
            return None
        expected = hmac.new(secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64decode(parts[2])):
            return None
        claims = json.loads(_b64decode(parts[1]))
    except (ValueError, TypeError, AttributeError):
        return None
    now = time.time()
    if isinstance(claims.get("exp"), (int, float)) and now >= claims["exp"]:
        return None
    if isinstance(claims.get("nbf"), (int, float)) and now < claims["nbf"]:
        return None
    return claims if isinstance(claims, dict) else None


def sign_jwt(claims: Dict[str, Any], secret: str) -> str:
    """Signs an HS256 token (tests and local tooling; production tokens come from your identity provider)."""
    head = _b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64encode(json.dumps(claims).encode())
    sig = _b64encode(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def tenant_from_authorization(authorization: Optional[str], secret: Optional[str] = None) -> Optional[str]:
    """Tenant of a request: the TENANT_CLAIM of its validated bearer token, else None."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    claims = verify_jwt(authorization[7:].strip(), os.environ.get("JWT_SECRET", "") if secret is None else secret)
    tenant = claims.get(TENANT_CLAIM) if claims else None
    return tenant if isinstance(tenant, str) and tenant.strip() else None
`;
}

/** Outbox relay in a daemon thread (the publisher, e.g. a pika connection, lives in that thread). */
export function renderPyWorker(m: DomainModel): string {
  return `"""Outbox relay worker: publishes the outbox every ${RELAY_INTERVAL_MS} ms through the configured broker
(app/runtime/broker.py: GHK_BROKER, AMQP_URL, PUBSUB_*, SERVICEBUS_*)."""
from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Callable

from app.runtime.broker import DEFAULT_TOPOLOGY, connect_broker
from app.runtime.outbox_relay import OutboxRelay

log = logging.getLogger(__name__)


def start_outbox_relay(dsn: str, interval: float = ${RELAY_INTERVAL_MS / 1000}) -> Callable[[], None]:
    """Starts the relay thread; returns a function that stops it."""
    stop = threading.Event()
    worker_id = f"${m.kebab}-{uuid.uuid4()}"

    def run() -> None:
        while not stop.is_set():
            try:
                broker = connect_broker()
                # GHK_DECLARE_TOPOLOGY=false when infrastructure as code owns the topology (least-privilege credentials).
                if os.environ.get("GHK_DECLARE_TOPOLOGY") != "false":
                    broker.declare(DEFAULT_TOPOLOGY)
                publisher = broker.publisher(DEFAULT_TOPOLOGY.exchange)
                try:
                    relay = OutboxRelay(dsn, publisher)
                    while not stop.is_set():
                        relay.publish_batch(worker_id)
                        stop.wait(interval)
                finally:
                    publisher.close()
                    broker.close()
            except Exception:  # broker or database unavailable: retry
                log.exception("outbox relay failed; retrying")
                stop.wait(5)

    threading.Thread(target=run, name="outbox-relay", daemon=True).start()
    return stop.set
`;
}

export function renderFastApiMain(m: DomainModel, siblings: DomainModel[] = []): string {
  const all = [m, ...siblings];
  return `"""FastAPI application for ${py(m.feature)} (generated by gherkin-ai): commands run through the runtime kernel."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from functools import lru_cache
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response

from app.auth import tenant_from_authorization
from app.domain import DomainValidationError
from app.runtime.command_service import CommandService
from app.runtime.broker import broker_configured
from app.worker import start_outbox_relay

STATUS = {"created": 202, "replayed": 200, "in-progress": 409}


@lru_cache
def command_service() -> CommandService:
    return CommandService(os.environ["DATABASE_URL"])


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop = None
    if broker_configured() and os.environ.get("DATABASE_URL"):
        stop = start_outbox_relay(os.environ["DATABASE_URL"])
    yield
    if stop:
        stop()


app = FastAPI(title=${py(m.feature)}, lifespan=lifespan)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


def _execute(aggregate_type: str, aggregate_id: str, command: str, response: Response, payload, authorization, idempotency_key, traceparent,
             commands: CommandService) -> Dict[str, Any]:
    tenant = tenant_from_authorization(authorization)
    if tenant is None:
        raise HTTPException(status_code=401, detail="A valid bearer token with a tenant is required")
    try:
        result = commands.handle(tenant, aggregate_id, command, payload or {}, idempotency_key, traceparent, aggregate_type=aggregate_type)
    except DomainValidationError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    response.status_code = STATUS.get(result.status, 200)
    return asdict(result)
${all.map(f => `

# ghk:implements ${f.pascal}
@app.post(${py(commandRoute(f) + '/{aggregate_id}/{command}')})
def execute_${f.snake}(
    aggregate_id: str,
    command: str,
    response: Response,
    payload: Optional[Dict[str, Any]] = None,
    authorization: Optional[str] = Header(default=None),
    idempotency_key: Optional[str] = Header(default=None),
    traceparent: Optional[str] = Header(default=None),
    commands: CommandService = Depends(command_service),
) -> Dict[str, Any]:
    """POST ${commandRoute(f)}/{id}/{command} (${f.commands.map(c => c.snake).join(', ')})."""
    return _execute(${py(f.pascal)}, aggregate_id, command, response, payload, authorization, idempotency_key, traceparent, commands)`).join('')}
`;
}

export function renderFastApiUnitTest(m: DomainModel): string {
  const first = m.commands[0];
  return `"""HTTP contract with a fake command service (no database)."""
import os

from fastapi.testclient import TestClient

from app.auth import TENANT_CLAIM, sign_jwt
from app.domain import DomainValidationError
from app.main import app, command_service
from app.runtime.command_service import CommandResult

SECRET = "unit-test-secret-with-at-least-32-chars"
os.environ["JWT_SECRET"] = SECRET
calls = []


class FakeCommands:
    def handle(self, tenant_id, aggregate_id, command, payload=None, idempotency_key=None, traceparent=None, aggregate_type=None):
        calls.append((tenant_id, aggregate_id, command, payload))
        if command == "does_not_exist":
            raise DomainValidationError(f"Unknown command {command}")
        return CommandResult("replayed" if idempotency_key == "seen" else "created", aggregate_id, ${py(first.event)}, 1)


app.dependency_overrides[command_service] = FakeCommands
client = TestClient(app)


def bearer(claims):
    return {"authorization": f"Bearer {sign_jwt(claims, SECRET)}"}


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_runs_a_command_for_the_token_tenant():
    res = client.post(${py(commandRoute(m) + '/agg-api/' + first.snake)}, json={"source": "api-test"},
                      headers={**bearer({TENANT_CLAIM: "acme"}), "x-tenant-id": "someone-else"})
    assert res.status_code == 202
    assert res.json()["status"] == "created"
    assert calls[-1] == ("acme", "agg-api", ${py(first.snake)}, {"source": "api-test"})


def test_idempotent_replay_returns_200():
    res = client.post(${py(commandRoute(m) + '/agg-api/' + first.snake)}, headers={**bearer({TENANT_CLAIM: "acme"}), "idempotency-key": "seen"})
    assert res.status_code == 200


def test_rejects_missing_or_invalid_tokens_and_x_tenant_id():
    url = ${py(commandRoute(m) + '/agg-api/' + first.snake)}
    assert client.post(url).status_code == 401
    assert client.post(url, headers={"x-tenant-id": "acme"}).status_code == 401
    assert client.post(url, headers=bearer({"sub": "u1"})).status_code == 401
    assert client.post(url, headers={"authorization": f"Bearer {sign_jwt({TENANT_CLAIM: 'acme'}, 'wrong')}"}).status_code == 401


def test_domain_validation_error_is_422():
    assert client.post(${py(commandRoute(m) + '/agg-api/does_not_exist')}, headers=bearer({TENANT_CLAIM: "acme"})).status_code == 422
`;
}

/** Integration test through the HTTP layer against PostgreSQL; `client` is a fixture body per framework. */
function renderPyHttpIntegration(m: DomainModel, setup: string, post: string): string {
  const first = m.commands[0];
  return `"""HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL)."""
import os
import uuid

import psycopg
import pytest

from app.auth import TENANT_CLAIM, sign_jwt
from app.runtime.schema import migrate

pytestmark = pytest.mark.integration
SECRET = ${py(TEST_SECRET)}
DSN = os.environ.get("DATABASE_URL", "")


${setup}


def test_runs_a_command_into_the_outbox_for_the_token_tenant_idempotently(client):
    migrate(DSN)
    tenant = f"tenant-{uuid.uuid4()}"
    aggregate_id = str(uuid.uuid4())
    headers = {"authorization": f"Bearer {sign_jwt({TENANT_CLAIM: tenant}, SECRET)}", "idempotency-key": str(uuid.uuid4()), "x-tenant-id": "someone-else"}
    url = f"${commandRoute(m)}/{aggregate_id}/${first.snake}"
    first = ${post}
    assert first.status_code == 202
    replay = ${post}
    assert replay.status_code == 200
    assert replay.json()["status"] == "replayed"
    with psycopg.connect(DSN) as conn:
        rows = conn.execute("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = %s", (aggregate_id,)).fetchall()
    assert rows == [(tenant,)]


def test_rejects_a_request_with_only_x_tenant_id(client):
    url = f"${commandRoute(m)}/{uuid.uuid4()}/${first.snake}"
    headers = {"x-tenant-id": "acme"}
    assert (${post}).status_code == 401
`;
}

export function renderFastApiHttpIntegration(m: DomainModel): string {
  return renderPyHttpIntegration(m, `@pytest.fixture
def client(monkeypatch):
    if not DSN:
        pytest.skip("DATABASE_URL is not set")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    from fastapi.testclient import TestClient

    from app.main import app, command_service

    app.dependency_overrides.pop(command_service, None)
    command_service.cache_clear()
    return TestClient(app)`, 'client.post(url, json={}, headers=headers)');
}

export function renderDjangoViews(m: DomainModel): string {
  return `"""Command endpoint over the runtime kernel (generated by gherkin-ai)."""
from __future__ import annotations

import json
import os
from dataclasses import asdict
from functools import lru_cache

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from app.auth import tenant_from_authorization
from app.domain import DomainValidationError
from app.runtime.command_service import CommandService

STATUS = {"created": 202, "replayed": 200, "in-progress": 409}


@lru_cache
def command_service() -> CommandService:
    return CommandService(os.environ["DATABASE_URL"])


@require_GET
def health(request):
    return JsonResponse({"status": "ok"})


# ghk:implements ${m.pascal}
@csrf_exempt
@require_POST
def execute(request, aggregate_id: str, command: str, aggregate_type: str = ${py(m.pascal)}):
    """POST ${commandRoute(m)}/<id>/<command> (${m.commands.map(c => c.snake).join(', ')})."""
    tenant = tenant_from_authorization(request.headers.get("Authorization"))
    if tenant is None:
        return JsonResponse({"detail": "A valid bearer token with a tenant is required"}, status=401)
    payload = {}
    if request.content_type == "application/json" and request.body:
        try:
            payload = json.loads(request.body)
        except ValueError:
            return JsonResponse({"detail": "The body must be a JSON object"}, status=400)
    try:
        result = command_service().handle(tenant, aggregate_id, command, payload if isinstance(payload, dict) else {},
                                          request.headers.get("Idempotency-Key"), request.headers.get("traceparent"),
                                          aggregate_type=aggregate_type)
    except DomainValidationError as err:
        return JsonResponse({"detail": str(err)}, status=422)
    return JsonResponse(asdict(result), status=STATUS.get(result.status, 200))
`;
}

export function renderDjangoRelayCommand(): string {
  return `"""python manage.py outbox_relay: publishes the outbox to the configured broker (DATABASE_URL; AMQP_URL, PUBSUB_* or SERVICEBUS_*)."""
import os
import signal
import threading

from django.core.management.base import BaseCommand

from app.worker import start_outbox_relay


class Command(BaseCommand):
    help = "Publish the transactional outbox to the event broker until interrupted."

    def handle(self, *args, **options):
        stop = start_outbox_relay(os.environ["DATABASE_URL"])
        done = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: done.set())
        try:
            done.wait()
        except KeyboardInterrupt:
            pass
        stop()
`;
}

export function renderDjangoUnitTest(m: DomainModel): string {
  const first = m.commands[0];
  return `"""HTTP contract with a fake command service (no database)."""
import pytest

from app import views
from app.auth import TENANT_CLAIM, sign_jwt
from app.domain import DomainValidationError
from app.runtime.command_service import CommandResult

SECRET = "unit-test-secret-with-at-least-32-chars"


class FakeCommands:
    def __init__(self):
        self.calls = []

    def handle(self, tenant_id, aggregate_id, command, payload=None, idempotency_key=None, traceparent=None, aggregate_type=None):
        self.calls.append((tenant_id, aggregate_id, command, payload))
        if command == "does_not_exist":
            raise DomainValidationError(f"Unknown command {command}")
        return CommandResult("replayed" if idempotency_key == "seen" else "created", aggregate_id, ${py(first.event)}, 1)


@pytest.fixture
def fake(monkeypatch):
    commands = FakeCommands()
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setattr(views, "command_service", lambda: commands)
    return commands


def bearer(claims, secret=SECRET):
    return f"Bearer {sign_jwt(claims, secret)}"


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_runs_a_command_for_the_token_tenant(client, fake):
    res = client.post(${py(commandRoute(m) + '/agg-api/' + first.snake)}, {"source": "api-test"}, content_type="application/json",
                      HTTP_AUTHORIZATION=bearer({TENANT_CLAIM: "acme"}), HTTP_X_TENANT_ID="someone-else")
    assert res.status_code == 202
    assert fake.calls[-1] == ("acme", "agg-api", ${py(first.snake)}, {"source": "api-test"})


def test_idempotent_replay_returns_200(client, fake):
    res = client.post(${py(commandRoute(m) + '/agg-api/' + first.snake)}, content_type="application/json",
                      HTTP_AUTHORIZATION=bearer({TENANT_CLAIM: "acme"}), HTTP_IDEMPOTENCY_KEY="seen")
    assert res.status_code == 200


def test_rejects_missing_or_invalid_tokens_and_x_tenant_id(client, fake):
    url = ${py(commandRoute(m) + '/agg-api/' + first.snake)}
    assert client.post(url).status_code == 401
    assert client.post(url, HTTP_X_TENANT_ID="acme").status_code == 401
    assert client.post(url, HTTP_AUTHORIZATION=bearer({"sub": "u1"})).status_code == 401
    assert client.post(url, HTTP_AUTHORIZATION=bearer({TENANT_CLAIM: "acme"}, "wrong")).status_code == 401


def test_domain_validation_error_is_422(client, fake):
    assert client.post(${py(commandRoute(m) + '/agg-api/does_not_exist')}, HTTP_AUTHORIZATION=bearer({TENANT_CLAIM: "acme"})).status_code == 422
`;
}

export function renderDjangoHttpIntegration(m: DomainModel): string {
  return renderPyHttpIntegration(m, `@pytest.fixture
def client(monkeypatch):
    if not DSN:
        pytest.skip("DATABASE_URL is not set")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    from django.test import Client

    from app import views

    views.command_service.cache_clear()
    return Client()`, 'client.post(url, {}, content_type="application/json", **{f"HTTP_{k.upper().replace(\'-\', \'_\')}": v for k, v in headers.items()})');
}
