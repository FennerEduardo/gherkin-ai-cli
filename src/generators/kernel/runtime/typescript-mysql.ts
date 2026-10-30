/* ==========================================================================
   gherkin-ai-cli - The TypeScript runtime kernel on MySQL 8 (stack.database "mysql")

   NestJS and Express only in this version. The PostgreSQL kernel is generated
   as usual and then adapted, so both share every line that does not touch the
   database:
     - src/runtime/db.ts: a Pool / PoolClient with the small part of the
       node-postgres API the kernel uses (query -> { rows, rowCount },
       connect / release / end), over mysql2. $1..$n become ? (in any order).
     - src/runtime/schema.ts: MySQL DDL (VARCHAR keys, DATETIME(6)), the
       schema is a MySQL database (default: the one in DATABASE_URL), and
       migrations are serialized with GET_LOCK instead of an advisory lock.
     - the statements that differ: ON CONFLICT -> INSERT IGNORE /
       ON DUPLICATE KEY UPDATE, the `key` column quoted, and the outbox
       claim (no UPDATE ... RETURNING: SELECT ... FOR UPDATE SKIP LOCKED,
       UPDATE and SELECT in one transaction).
   Tenant isolation is the repository filter (tenant_id in every query); MySQL
   has no row-level security to add as defense in depth.
   ========================================================================== */

import type { GherkinAIConfig } from '../../../core/config';

type File = { filename: string; content: string };

export const MYSQL_DRIVER = { mysql2: '^3.15.0' };

export const usesMysql = (config?: Pick<GherkinAIConfig, 'stack'>) => ['mysql', 'mariadb'].includes((config?.stack?.database || '').toLowerCase());

const DB_TS = `// MySQL 8 behind the part of the node-postgres API the runtime kernel uses (stack.database "mysql").
// Statements keep PostgreSQL-style $1..$n placeholders; they are sent as ? with the values reordered.
import mysql from 'mysql2/promise';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface QueryResult {
  rows: Row[];
  rowCount: number | null;
}

type Queryable = { query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> };

function toMysql(text: string, params: unknown[] = []): [string, unknown[]] {
  const values: unknown[] = [];
  const sql = text.replace(/\\$(\\d+)/g, (_m, n: string) => {
    values.push(params[Number(n) - 1]);
    return '?';
  });
  return [sql, values];
}

async function run(target: Queryable, text: string, params?: unknown[]): Promise<QueryResult> {
  const [sql, values] = toMysql(text, params);
  const [result] = await target.query(sql, values);
  if (Array.isArray(result)) return { rows: result as Row[], rowCount: result.length };
  return { rows: [], rowCount: (result as { affectedRows: number }).affectedRows };
}

export class PoolClient {
  constructor(private readonly connection: mysql.PoolConnection) {}

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    return run(this.connection, text, params);
  }

  release(): void {
    this.connection.release();
  }
}

/** Connection settings from a mysql:// URL. sslmode=require (or ssl-mode=REQUIRED) encrypts the connection. */
export function connectionOptions(connectionString = process.env.DATABASE_URL ?? 'mysql://root@localhost:3306/app'): mysql.PoolOptions {
  const url = new URL(connectionString);
  const mode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode') ?? '';
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || undefined,
    dateStrings: true,
    // As with PostgreSQL's sslmode=require: encrypted, the managed server's certificate is not verified.
    ...(/^(require|required|verify-ca|verify-full|verify_identity)$/i.test(mode) ? { ssl: { rejectUnauthorized: false } } : {})
  };
}

export class Pool {
  private readonly pool: mysql.Pool;

  constructor(options: { connectionString?: string; max?: number } = {}) {
    this.pool = mysql.createPool({ ...connectionOptions(options.connectionString), connectionLimit: options.max ?? 10 });
  }

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    return run(this.pool, text, params);
  }

  async connect(): Promise<PoolClient> {
    return new PoolClient(await this.pool.getConnection());
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}
`;

const TOKEN = '__SCHEMA__';
const MYSQL_TABLES = [
  `CREATE TABLE IF NOT EXISTS ${TOKEN}.ghk_aggregates (tenant_id VARCHAR(191) NOT NULL, aggregate_type VARCHAR(191) NOT NULL, id VARCHAR(191) NOT NULL, state TEXT NOT NULL, version INT NOT NULL, updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (tenant_id, aggregate_type, id))`,
  `CREATE TABLE IF NOT EXISTS ${TOKEN}.ghk_outbox (id VARCHAR(64) NOT NULL PRIMARY KEY, tenant_id VARCHAR(191) NOT NULL, aggregate_id VARCHAR(191) NOT NULL, event_type VARCHAR(191) NOT NULL, payload LONGTEXT NOT NULL, traceparent VARCHAR(255), created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), claimed_by VARCHAR(191), claimed_until DATETIME(6), published_at DATETIME(6), attempts INT NOT NULL DEFAULT 0, last_error TEXT, failed_at DATETIME(6), INDEX ghk_outbox_pending (published_at, failed_at, created_at))`,
  `CREATE TABLE IF NOT EXISTS ${TOKEN}.ghk_idempotency (tenant_id VARCHAR(191) NOT NULL, \`key\` VARCHAR(191) NOT NULL, status VARCHAR(32) NOT NULL, response LONGTEXT, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (tenant_id, \`key\`))`,
  `CREATE TABLE IF NOT EXISTS ${TOKEN}.ghk_inbox (consumer VARCHAR(191) NOT NULL, message_id VARCHAR(191) NOT NULL, processed_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (consumer, message_id))`,
  `CREATE TABLE IF NOT EXISTS ${TOKEN}.ghk_sagas (id VARCHAR(191) NOT NULL PRIMARY KEY, tenant_id VARCHAR(191) NOT NULL, status VARCHAR(32) NOT NULL, completed_steps VARCHAR(4000) NOT NULL DEFAULT '', updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`
];

const SCHEMA_TS = (ext: string) => `import { Pool } from './db${ext}';

const TABLES: string[] = ${JSON.stringify(MYSQL_TABLES, null, 2)};

/** The kernel's schema is a MySQL database: by default the one in DATABASE_URL. */
export function defaultSchema(url = process.env.DATABASE_URL): string {
  try {
    return decodeURIComponent(new URL(url ?? '').pathname.slice(1)) || 'app';
  } catch {
    return 'app';
  }
}

/** Validated, quoted database name (the tests use one database per test). */
export function schemaName(schema = defaultSchema()): string {
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(schema)) throw new Error(\`Invalid schema name: \${schema}\`);
  return \`\\\`\${schema}\\\`\`;
}

/** DATABASE_URL as given (kept for symmetry with the PostgreSQL kernel). */
export function pgConnectionString(url = process.env.DATABASE_URL): string | undefined {
  return url;
}

/**
 * Creates the runtime tables (idempotent). Replicas starting together are serialized with a named lock.
 * Another database than DATABASE_URL's (tests) is created first; the service's own is never created here,
 * so its user needs no global CREATE privilege.
 */
export async function migrate(pool: Pool, schema = defaultSchema()): Promise<void> {
  const s = schemaName(schema);
  const client = await pool.connect();
  try {
    await client.query("SELECT GET_LOCK('ghk_runtime_schema', 60)");
    if (schema !== defaultSchema()) await client.query(\`CREATE DATABASE IF NOT EXISTS \${s}\`);
    for (const statement of TABLES) await client.query(statement.split('${TOKEN}').join(s));
  } finally {
    await client.query("SELECT RELEASE_LOCK('ghk_runtime_schema')").catch(() => undefined);
    client.release();
  }
}
`;

/** The outbox claim without UPDATE ... RETURNING, as a method of OutboxRelay. */
const CLAIM_METHOD = `  /** Locks the next batch (SKIP LOCKED), leases it and reads it back, in one transaction: a MySQL UPDATE returns no rows. */
  private async claim(workerId: string, limit: number) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const due = (await client.query(
        \`SELECT id FROM \${this.s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(6))
         ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED\`,
        [limit]
      )).rows.map(r => String(r.id));
      if (due.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const ids = (from: number) => due.map((_, i) => \`$\${i + from}\`).join(', ');
      await client.query(
        \`UPDATE \${this.s}.ghk_outbox SET claimed_by = $1, claimed_until = CURRENT_TIMESTAMP(6) + INTERVAL $2 SECOND, attempts = attempts + 1 WHERE id IN (\${ids(3)})\`,
        [workerId, this.leaseSeconds, ...due]
      );
      const { rows } = await client.query(
        \`SELECT id, tenant_id, aggregate_id, event_type, payload, traceparent, attempts FROM \${this.s}.ghk_outbox WHERE id IN (\${ids(1)}) ORDER BY created_at\`,
        due
      );
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

`;

/** [PostgreSQL text, MySQL text] pairs, as they appear in the generated sources. */
const STATEMENTS: [string, string][] = [
  ["INSERT INTO ${this.s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING",
    "INSERT IGNORE INTO ${this.s}.ghk_idempotency (tenant_id, \\`key\\`, status) VALUES ($1, $2, 'PROCESSING')"],
  ['SELECT status, response FROM ${this.s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2',
    'SELECT status, response FROM ${this.s}.ghk_idempotency WHERE tenant_id = $1 AND \\`key\\` = $2'],
  ["UPDATE ${this.s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2",
    "UPDATE ${this.s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND \\`key\\` = $2"],
  ['VALUES ($1, $2, $3, $4, $5)\n         ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()',
    'VALUES ($1, $2, $3, $4, $5) AS incoming\n         ON DUPLICATE KEY UPDATE state = incoming.state, version = incoming.version, updated_at = CURRENT_TIMESTAMP(6)'],
  ['INSERT INTO ${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    'INSERT IGNORE INTO ${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2)'],
  ["INSERT INTO ${this.s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING",
    "INSERT IGNORE INTO ${this.s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING')"],
  // Runtime integration tests.
  ['SELECT count(*)::int AS n FROM', 'SELECT count(*) AS n FROM'],
  ['DROP SCHEMA IF EXISTS ${schema} CASCADE', 'DROP DATABASE IF EXISTS ${schema}'],
  ["'key = $1'", "'`key` = $1'"],
  ['runtime (PostgreSQL + event broker)', 'runtime (MySQL + event broker)']
];

const RELAY_CLAIM = /const \{ rows \} = await this\.pool\.query\(\n\s+`UPDATE \$\{this\.s\}\.ghk_outbox SET claimed_by[\s\S]*?\[workerId, this\.leaseSeconds, limit\]\n\s+\);/;

/** The relative module specifier of src/runtime/<name> from a generated file. */
function runtimeModule(filename: string, name: string, ext: string): string {
  const from = filename.split('/').slice(0, -1);
  const to = ['src', 'runtime'];
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const up = from.length - common;
  const rel = [...(up ? Array(up).fill('..') : ['.']), ...to.slice(common), name].join('/');
  return `${rel}${ext}`;
}

/**
 * Adapts a generated NestJS / Express project (PostgreSQL kernel) to MySQL. `esm`: import specifiers
 * carry ".js" (NestJS 12).
 */
export function mysqlizeTsProject(files: File[], esm: boolean): File[] {
  const ext = esm ? '.js' : '';
  const out = files.map(f => {
    if (!/\.ts$/.test(f.filename)) return f;
    if (f.filename === 'src/runtime/schema.ts') return { ...f, content: SCHEMA_TS(ext) };
    let content = f.content.replace(/from 'pg'/g, `from '${runtimeModule(f.filename, 'db', ext)}'`);
    for (const [pg, my] of STATEMENTS) content = content.split(pg).join(my);
    if (RELAY_CLAIM.test(content)) {
      content = content.replace(RELAY_CLAIM, 'const rows = await this.claim(workerId, limit);')
        // A function, not a string: "$$" in a replacement string would collapse to "$".
        .replace('  async publishBatch(', () => `${CLAIM_METHOD}  async publishBatch(`);
    }
    if (f.filename.startsWith('src/runtime/') && content.includes("schema = 'public'")) {
      content = content.replace(/schema = 'public'/g, 'schema = defaultSchema()')
        .replace(/import \{ schemaName \} from '\.\/schema(\.js)?';/, (_m, js = '') => `import { defaultSchema, schemaName } from './schema${js}';`);
    }
    return { ...f, content };
  });
  return [...out, { filename: 'src/runtime/db.ts', content: DB_TS }];
}
