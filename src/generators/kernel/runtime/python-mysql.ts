/* ==========================================================================
   gherkin-ai-cli - Python runtime kernel on MySQL 8 (stack.kernelDatabase
   "mysql"; PLAN-3.3.0 X-01b). FastAPI and Django.

   Same approach as the TypeScript and JVM kernels (typescript-mysql.ts,
   jvm-mysql.ts): the PostgreSQL kernel is generated, then adapted:
     - runtime/db.py: PyMySQL behind the psycopg 3 call shape the kernel
       uses (connect(dsn, autocommit), conn.execute(sql, params) returning a
       cursor, commit on a clean `with` exit, rollback on an exception), so
       the command service, relay, inbox and saga keep their structure;
     - a schema is a MySQL database (the tests use one per test; "public"
       is the database of DATABASE_URL); migrations serialized with GET_LOCK;
     - ON CONFLICT DO NOTHING -> INSERT IGNORE; the aggregate upsert ->
       ON DUPLICATE KEY UPDATE; `key` quoted; now() -> CURRENT_TIMESTAMP(6);
     - the outbox claim (UPDATE ... RETURNING does not exist in MySQL):
       SELECT ... FOR UPDATE SKIP LOCKED, UPDATE the lease, read back, in
       one transaction;
     - psycopg -> PyMySQL + cryptography (caching_sha2_password).
   Tenant isolation is the repository filter (tenant_id in every query):
   MySQL has no row-level security.
   ========================================================================== */

import { MYSQL_RUNTIME_TABLES, MYSQL_SCHEMA_TOKEN } from './typescript-mysql';

type File = { filename: string; content: string };

const py = (s: string) => JSON.stringify(s);

const DB_PY = `"""MySQL access for the runtime kernel: PyMySQL behind the small part of the psycopg 3 interface the kernel uses.

connect(dsn, autocommit=False) opens mysql://user:password@host:3306/database[?ssl-mode=REQUIRED]. In a \`with\`
block the transaction is committed on a clean exit and rolled back on an exception, then the connection is closed."""
from __future__ import annotations

import urllib.parse
from typing import Any, Optional, Sequence

import pymysql

_TLS_MODES = {"require", "required", "verify-ca", "verify_ca", "verify-full", "verify_identity", "verify-identity"}


def database_of(dsn: str) -> Optional[str]:
    """The database named in the URL path, or None."""
    path = urllib.parse.urlsplit(dsn or "").path or ""
    return urllib.parse.unquote(path[1:]) or None


def _params(dsn: str) -> dict:
    url = urllib.parse.urlsplit(dsn)
    query = urllib.parse.parse_qs(url.query)
    mode = next((v[0] for k, v in query.items() if k.lower().replace("_", "-") in ("ssl-mode", "sslmode")), "").lower()
    params = dict(host=url.hostname or "localhost", port=url.port or 3306, user=urllib.parse.unquote(url.username or ""),
                  password=urllib.parse.unquote(url.password or ""), database=database_of(dsn), charset="utf8mb4")
    if mode in _TLS_MODES:
        params["ssl"] = {}  # encrypt; certificate verification follows the platform defaults of the managed database
    return params


class Cursor:
    """Result of execute(): rowcount, fetchone() and fetchall() as a list of tuples (as psycopg returns)."""

    def __init__(self, cursor) -> None:
        self._cursor = cursor
        self.rowcount = cursor.rowcount

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self) -> list:
        return list(self._cursor.fetchall())


class Connection:
    def __init__(self, dsn: str, autocommit: bool = False) -> None:
        self._conn = pymysql.connect(autocommit=autocommit, **_params(dsn))

    def execute(self, sql: str, params: Optional[Sequence[Any]] = None) -> Cursor:
        cursor = self._conn.cursor()
        cursor.execute(sql, tuple(params) if params else None)
        return Cursor(cursor)

    def begin(self) -> None:
        self._conn.begin()

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Connection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._conn.close()


def connect(dsn: str, autocommit: bool = False) -> Connection:
    return Connection(dsn, autocommit)
`;

const SCHEMA_PY = `"""Runtime tables on MySQL 8 (docs/RUNTIME-KERNEL.md): a schema is a MySQL database."""
from __future__ import annotations

import os
import re
from typing import Optional

from . import db

STATEMENTS = [
${MYSQL_RUNTIME_TABLES.map(s => `    ${py(s)},`).join('\n')}
]

# Tenant isolation is the repository filter (tenant_id in every query): MySQL has no row-level security.


def _plain(schema: str, dsn: Optional[str] = None) -> str:
    if not schema or schema == "public":
        return db.database_of(dsn or os.environ.get("DATABASE_URL", "")) or "app"
    return schema


def schema_name(schema: str = "public", dsn: Optional[str] = None) -> str:
    """Validated, quoted database name; "public" is the database of the DSN (or DATABASE_URL)."""
    s = _plain(schema, dsn)
    if not re.fullmatch(r"[A-Za-z0-9_$-]{1,64}", s):
        raise ValueError(f"Invalid schema name: {s}")
    return f"\`{s}\`"


def migrate(dsn: str, schema: str = "public") -> None:
    """Creates the runtime tables (idempotent); replicas starting together are serialized with a named lock.
    Another database than the DSN's (tests) is created first; the service's own is never created here, so its
    user needs no global CREATE privilege."""
    s = schema_name(schema, dsn)
    with db.connect(dsn, autocommit=True) as conn:
        conn.execute("SELECT GET_LOCK('ghk_runtime_schema', 60)").fetchone()
        try:
            if _plain(schema, dsn) != db.database_of(dsn):
                conn.execute(f"CREATE DATABASE IF NOT EXISTS {s}")
            for statement in STATEMENTS:
                conn.execute(statement.replace(${py(MYSQL_SCHEMA_TOKEN)}, s))
        finally:
            conn.execute("SELECT RELEASE_LOCK('ghk_runtime_schema')").fetchone()
`;

/** The outbox claim in one transaction: MySQL's UPDATE returns no rows. */
const CLAIM = `            # MySQL has no UPDATE ... RETURNING: lock the next batch (SKIP LOCKED), lease it and read it back.
            conn.begin()
            try:
                due = [r[0] for r in conn.execute(
                    f"SELECT id FROM {s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL "
                    f"AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(6)) ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED",
                    (limit,)).fetchall()]
                rows = []
                if due:
                    marks = ", ".join(["%s"] * len(due))
                    conn.execute(f"UPDATE {s}.ghk_outbox SET claimed_by = %s, claimed_until = CURRENT_TIMESTAMP(6) + INTERVAL %s SECOND, "
                                 f"attempts = attempts + 1 WHERE id IN ({marks})", (worker_id, self.lease_seconds, *due))
                    rows = conn.execute(f"SELECT id, tenant_id, aggregate_id, event_type, payload, traceparent FROM {s}.ghk_outbox "
                                        f"WHERE id IN ({marks}) ORDER BY created_at", due).fetchall()
                conn.commit()
            except Exception:
                conn.rollback()
                raise`;

const CLAIM_BLOCK = / {12}rows = conn\.execute\(\n {16}f"UPDATE \{s\}\.ghk_outbox SET claimed_by[\s\S]*?\.fetchall\(\)/;

/** [PostgreSQL text, MySQL text] pairs as they appear in the generated Python sources. */
const STATEMENTS: [string, string][] = [
  [`f"INSERT INTO {s}.ghk_idempotency (tenant_id, key, status) VALUES (%s, %s, 'PROCESSING') ON CONFLICT DO NOTHING"`,
    `f"INSERT IGNORE INTO {s}.ghk_idempotency (tenant_id, \`key\`, status) VALUES (%s, %s, 'PROCESSING')"`],
  [`ghk_idempotency WHERE tenant_id = %s AND key = %s`, `ghk_idempotency WHERE tenant_id = %s AND \`key\` = %s`],
  [`response = %s WHERE tenant_id = %s AND key = %s`, `response = %s WHERE tenant_id = %s AND \`key\` = %s`],
  [`f"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"`,
    `f"AS incoming ON DUPLICATE KEY UPDATE state = incoming.state, version = incoming.version, updated_at = CURRENT_TIMESTAMP(6)"`],
  [`f"INSERT INTO {self.s}.ghk_inbox (consumer, message_id) VALUES (%s, %s) ON CONFLICT DO NOTHING"`,
    `f"INSERT IGNORE INTO {self.s}.ghk_inbox (consumer, message_id) VALUES (%s, %s)"`],
  [`f"INSERT INTO {self.s}.ghk_sagas (id, tenant_id, status) VALUES (%s, %s, 'RUNNING') ON CONFLICT (id) DO NOTHING"`,
    `f"INSERT IGNORE INTO {self.s}.ghk_sagas (id, tenant_id, status) VALUES (%s, %s, 'RUNNING')"`],
  [`self.s = schema_name(schema)`, `self.s = schema_name(schema, dsn)`],
  // Runtime integration tests: a schema is a database.
  [`f"DROP SCHEMA IF EXISTS {name} CASCADE"`, `f"DROP DATABASE IF EXISTS {name}"`],
  [`"ghk_idempotency", "key = %s"`, `"ghk_idempotency", "\`key\` = %s"`],
  // The SQLAlchemy engine (app/database.py) on the same driver; the query (ssl-mode) is the kernel's concern.
  ['# libpq-style URLs (postgres://, postgresql://) use the psycopg 3 driver.\nfor prefix in ("postgres://", "postgresql://"):\n    if DATABASE_URL.startswith(prefix):\n        DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len(prefix):]',
    '# mysql:// URLs use the PyMySQL driver of the runtime kernel (stack.kernelDatabase "mysql").\nif DATABASE_URL.startswith("mysql://"):\n    DATABASE_URL = "mysql+pymysql://" + DATABASE_URL[len("mysql://"):].split("?")[0]'],
  // Dependencies (pyproject.toml).
  ['"psycopg[binary]>=3.2",', '"PyMySQL>=1.1",\n    "cryptography>=43",'],
  ['against PostgreSQL and RabbitMQ', 'against MySQL and RabbitMQ']
];

/** Adapts a generated FastAPI / Django project (PostgreSQL kernel) to MySQL. */
export function mysqlizePyProject(files: File[]): File[] {
  const schemaFile = files.find(f => /(^|\/)runtime\/schema\.py$/.test(f.filename));
  if (!schemaFile) return files;
  const runtimeDir = schemaFile.filename.replace(/schema\.py$/, '');
  const runtimePkg = runtimeDir.replace(/\/$/, '').replace(/\//g, '.');
  const out = files.map(f => {
    if (f === schemaFile) return { ...f, content: SCHEMA_PY };
    if (!/\.(py|toml)$/.test(f.filename)) return f;
    let content = f.content;
    for (const [pg, my] of STATEMENTS) content = content.split(pg).join(my);
    if (f.filename.endsWith('.py') && /^import psycopg$/m.test(content)) {
      const inRuntime = f.filename.startsWith(runtimeDir) && !f.filename.slice(runtimeDir.length).includes('/');
      // Imported as kernel_db: generated code already names connections `db`.
      content = content.replace(/^import psycopg$/m, inRuntime ? 'from . import db as kernel_db' : `from ${runtimePkg} import db as kernel_db`).replace(/\bpsycopg\.connect\(/g, 'kernel_db.connect(');
    }
    if (CLAIM_BLOCK.test(content)) content = content.replace(CLAIM_BLOCK, () => CLAIM);
    // now() in SQL strings (not datetime.now()).
    if (f.filename.endsWith('.py')) content = content.replace(/(?<![.\w])now\(\)/g, 'CURRENT_TIMESTAMP(6)');
    return { ...f, content };
  });
  return [...out, { filename: `${runtimeDir}db.py`, content: DB_PY }];
}
