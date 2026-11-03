/* ==========================================================================
   gherkin-ai-cli - The TypeScript runtime kernel on MongoDB 8 (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). NestJS and Express.

   The PostgreSQL kernel is generated, then its database layer is replaced;
   the broker, telemetry, application layer and the IT1-IT7 suite are kept:
     - src/runtime/db.ts: `Pool` over the official driver (MongoClient), and
       inTransaction(): a transaction that is run again on a transient error,
       a write conflict or a duplicate key from a concurrent insert, which is
       what PostgreSQL's row locks (FOR UPDATE, the unique index wait) do;
     - collections with the kernel's column names (ghk_aggregates, ghk_outbox,
       ghk_idempotency, ghk_inbox, ghk_sagas) and unique indexes for the keys;
       a schema is a MongoDB database ("public" is the one in DATABASE_URL);
     - the command service: idempotency lookup, aggregate load, domain logic,
       aggregate save and outbox insert in one transaction;
     - the outbox claim: one atomic findOneAndUpdate per row with a lease on
       the server's clock ($$NOW) instead of FOR UPDATE SKIP LOCKED;
     - the inbox record and the handler share a transaction (MessageMeta
       carries its session).
   Transactions need a replica set: one node is enough (docs/RUNTIME-KERNEL.md).
   Tenant isolation is the repository filter (tenant_id in every query).
   ========================================================================== */

import { runtimeModule } from './typescript-mysql';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS } from './shared';

type File = { filename: string; content: string };

export const MONGO_DRIVER = { mongodb: '^6.12.0' };

const DB_TS = `// MongoDB 8 for the runtime kernel (stack.kernelDatabase "mongodb"). Transactions need a replica set (one node is enough).
import { MongoClient, MongoError, type ClientSession, type Db } from 'mongodb';

/** The database in the URL path ("app" when it names none). */
export function databaseOf(url = process.env.DATABASE_URL): string {
  try {
    return decodeURIComponent(new URL(url ?? '').pathname.slice(1)) || 'app';
  } catch {
    return 'app';
  }
}

/** The kernel's connection: one MongoClient (it connects on first use and pools its connections). */
export class Pool {
  readonly client: MongoClient;
  readonly database: string;

  constructor(options: { connectionString?: string; max?: number } = {}) {
    const url = options.connectionString ?? process.env.DATABASE_URL ?? 'mongodb://localhost:27017/app?directConnection=true';
    this.client = new MongoClient(url, { maxPoolSize: options.max ?? 20 });
    this.database = databaseOf(url);
  }

  /** A database: the one in DATABASE_URL by default. */
  db(name = this.database): Db {
    return this.client.db(name);
  }

  /** Readiness probe. */
  async ping(): Promise<void> {
    await this.db().command({ ping: 1 });
  }

  end(): Promise<void> {
    return this.client.close();
  }
}

const RETRYABLE_CODES = new Set([112, 11000, 251]); // WriteConflict, DuplicateKey (a concurrent insert), NoSuchTransaction

function retryable(err: unknown): boolean {
  return err instanceof MongoError && (err.hasErrorLabel('TransientTransactionError') || RETRYABLE_CODES.has(Number(err.code)));
}

/**
 * Runs fn in a transaction (snapshot reads, majority writes). On a transient error, a write conflict or a
 * duplicate key from a concurrent transaction the whole function runs again on fresh data: the concurrent
 * writer has committed by then, as a PostgreSQL row lock would have waited for it. Other errors (a domain
 * error) abort the transaction and propagate.
 */
export async function inTransaction<T>(pool: Pool, fn: (session: ClientSession) => Promise<T>, attempts = 60): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const session = pool.client.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      const result = await fn(session);
      for (let commit = 1; ; commit++) {
        try {
          await session.commitTransaction();
          break;
        } catch (err) {
          if (commit < 5 && err instanceof MongoError && err.hasErrorLabel('UnknownTransactionCommitResult')) continue;
          throw err;
        }
      }
      return result;
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
      if (attempt < attempts && retryable(err)) {
        await new Promise(r => setTimeout(r, Math.min(5 * attempt, 100)));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}
`;

const SCHEMA_TS = (ext: string) => `import { databaseOf, type Pool } from './db${ext}';

/** The kernel's collections and their keys (unique indexes). */
const COLLECTIONS: Record<string, Record<string, 1>[]> = {
  ghk_aggregates: [{ tenant_id: 1, aggregate_type: 1, id: 1 }],
  ghk_outbox: [],
  ghk_idempotency: [{ tenant_id: 1, key: 1 }],
  ghk_inbox: [{ consumer: 1, message_id: 1 }],
  ghk_sagas: []
};

// Tenant isolation is the repository filter (tenant_id in every query).

/** The kernel's schema is a MongoDB database: by default the one in DATABASE_URL. */
export function defaultSchema(url = process.env.DATABASE_URL): string {
  return databaseOf(url);
}

/** Validated database name (the tests use one database per test); "public" is DATABASE_URL's. */
export function schemaName(schema = defaultSchema()): string {
  const s = schema === 'public' ? defaultSchema() : schema;
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(s)) throw new Error(\`Invalid schema name: \${s}\`);
  return s;
}

/** DATABASE_URL as given (kept for symmetry with the PostgreSQL kernel). */
export function pgConnectionString(url = process.env.DATABASE_URL): string | undefined {
  return url;
}

/**
 * Creates the collections and indexes (idempotent; replicas starting together may both try, which is harmless).
 * Collections exist before any transaction writes to them.
 */
export async function migrate(pool: Pool, schema = defaultSchema()): Promise<void> {
  const db = pool.db(schemaName(schema));
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const [name, keys] of Object.entries(COLLECTIONS)) {
    if (!existing.has(name)) await db.createCollection(name).catch((err: { code?: number }) => { if (err.code !== 48) throw err; });
    for (const key of keys) await db.collection(name).createIndex(key, { unique: true });
  }
  await db.collection('ghk_outbox').createIndex({ published_at: 1, failed_at: 1, created_at: 1 });
}
`;

const COMMAND_SERVICE_CLASS = `export class CommandService {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = defaultSchema()) {
    this.s = schemaName(schema);
  }

  async handle(req: CommandRequest): Promise<CommandResult> {
    if (!req.tenantId) throw new DomainValidationError('tenantId is required');
    const aggregateType = req.aggregateType ?? DEFAULT_AGGREGATE;
    const kind = AGGREGATES[aggregateType];
    if (!kind) throw new DomainValidationError(\`Unknown aggregate type \${aggregateType}\`);
    const parent = contextFrom(req.traceparent);
    const span = tracer().startSpan(\`\${aggregateType}.\${req.command}\`, {
      kind: SpanKind.INTERNAL,
      attributes: { 'tenant.id': req.tenantId, 'aggregate.id': req.aggregateId }
    }, parent);
    const ctx = trace.setSpan(parent, span);
    const db = this.pool.db(this.s);
    try {
      return await inTransaction<CommandResult>(this.pool, async session => {
        if (req.idempotencyKey) {
          const done = await db.collection('ghk_idempotency').findOne({ tenant_id: req.tenantId, key: req.idempotencyKey }, { session });
          if (done) {
            if (done.status === 'COMPLETED') return { ...(JSON.parse(String(done.response)) as CommandResult), status: 'replayed' };
            return { status: 'in-progress', aggregateId: req.aggregateId };
          }
          await db.collection('ghk_idempotency').insertOne({ tenant_id: req.tenantId, key: req.idempotencyKey, status: 'PROCESSING', created_at: new Date() }, { session });
        }
        const key = { tenant_id: req.tenantId, aggregate_type: aggregateType, id: req.aggregateId };
        const row = await db.collection('ghk_aggregates').findOne(key, { session });
        const aggregate = row ? kind.restore(req.aggregateId, String(row.state), Number(row.version)) : kind.create(req.aggregateId);
        const handler = kind.commands[req.command];
        if (!handler) throw new DomainValidationError(\`Unknown command \${req.command}\`);
        const event = handler(aggregate, { id: req.aggregateId, payload: req.payload ?? {} });

        // A concurrent change of the same aggregate is a write conflict: the transaction runs again on its result.
        await db.collection('ghk_aggregates').updateOne(key, { $set: { state: aggregate.state, version: aggregate.version, updated_at: new Date() } }, { upsert: true, session });
        await db.collection<{ _id: string; [field: string]: unknown }>('ghk_outbox').insertOne({
          _id: randomUUID(), tenant_id: req.tenantId, aggregate_id: req.aggregateId, event_type: event.type, payload: JSON.stringify(event),
          traceparent: traceparentOf(ctx) ?? null, created_at: new Date(), claimed_by: null, claimed_until: null, published_at: null,
          attempts: 0, last_error: null, failed_at: null
        }, { session });
        const result: CommandResult = { status: 'created', aggregateId: req.aggregateId, eventType: event.type, version: event.version };
        if (req.idempotencyKey) {
          await db.collection('ghk_idempotency').updateOne({ tenant_id: req.tenantId, key: req.idempotencyKey }, { $set: { status: 'COMPLETED', response: JSON.stringify(result) } }, { session });
        }
        return result;
      });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  }

  /** The aggregate as tenant \`tenantId\` sees it (undefined for other tenants' aggregates). */
  async load(tenantId: string, aggregateId: string, aggregateType = DEFAULT_AGGREGATE): Promise<{ state: string; version: number } | undefined> {
    const row = await this.pool.db(this.s).collection('ghk_aggregates').findOne({ tenant_id: tenantId, aggregate_type: aggregateType, id: aggregateId });
    return row ? { state: String(row.state), version: Number(row.version) } : undefined;
  }
}
`;

const RELAY_TS = (ext: string) => `import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pool } from './db${ext}';
import type { EventPublisher } from './broker${ext}';
import { defaultSchema, schemaName } from './schema${ext}';
import { contextFrom, traceparentOf, tracer } from './telemetry${ext}';

interface OutboxRow {
  _id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
  payload: string;
  traceparent: string | null;
  attempts: number;
  created_at: Date;
  claimed_by: string | null;
  claimed_until: Date | null;
  published_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
}

/**
 * Publishes pending outbox documents. Each one is claimed with an atomic findOneAndUpdate and a lease on the
 * server's clock, so concurrent relays never publish the same event; the publisher resolves only once the broker
 * has accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before it is marked published.
 * Use one relay (and publisher) per worker.
 */
export class OutboxRelay {
  private readonly s: string;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: EventPublisher,
    schema = defaultSchema(),
    private readonly leaseSeconds = ${LEASE_SECONDS},
    private readonly maxAttempts = ${MAX_PUBLISH_ATTEMPTS}
  ) {
    this.s = schemaName(schema);
  }

  /** The oldest pending event nobody holds a lease on, leased to workerId. */
  private claim(workerId: string): Promise<OutboxRow | null> {
    return this.pool.db(this.s).collection<OutboxRow>('ghk_outbox').findOneAndUpdate(
      { published_at: null, failed_at: null, $or: [{ claimed_until: null }, { $expr: { $lt: ['$claimed_until', '$$NOW'] } }] },
      [{ $set: { claimed_by: { $literal: workerId }, claimed_until: { $add: ['$$NOW', this.leaseSeconds * 1000] }, attempts: { $add: ['$attempts', 1] } } }],
      { sort: { created_at: 1, _id: 1 }, returnDocument: 'after' }
    );
  }

  async publishBatch(workerId: string, limit = 50): Promise<number> {
    const outbox = this.pool.db(this.s).collection<OutboxRow>('ghk_outbox');
    let published = 0;
    for (let n = 0; n < limit; n++) {
      const row = await this.claim(workerId);
      if (!row) break;
      const parent = contextFrom(row.traceparent ?? undefined);
      const span = tracer().startSpan(\`\${this.publisher.destination} publish\`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': this.publisher.system, 'messaging.destination.name': this.publisher.destination, 'messaging.message.id': row._id, 'tenant.id': row.tenant_id }
      }, parent);
      try {
        const traceparent = traceparentOf(trace.setSpan(parent, span));
        await this.publisher.publish({ messageId: row._id, eventType: row.event_type, tenantId: row.tenant_id, traceparent, body: Buffer.from(row.payload) });
        await outbox.updateOne({ _id: row._id, claimed_by: workerId }, [{ $set: { published_at: '$$NOW', claimed_until: null } }]);
        published++;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        await outbox.updateOne({ _id: row._id }, [{ $set: {
          claimed_until: null,
          last_error: { $literal: String((err as Error).message ?? err) },
          failed_at: { $cond: [{ $gte: ['$attempts', this.maxAttempts] }, '$$NOW', null] }
        } }]);
      } finally {
        span.end();
      }
    }
    return published;
  }
}
`;

const INBOX_TS = (ext: string) => `import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ClientSession, Db } from 'mongodb';
import { inTransaction, type Pool } from './db${ext}';
import type { Delivery, EventSubscription } from './broker${ext}';
import { defaultSchema, schemaName } from './schema${ext}';
import { contextFrom, tracer } from './telemetry${ext}';

export interface MessageMeta {
  messageId: string;
  tenantId?: string;
  eventType?: string;
  /** Transaction the inbox record is written in; pass it to the handler's own writes. */
  session: ClientSession;
  /** The kernel's database. */
  db: Db;
}

export type MessageHandler = (event: Record<string, unknown>, meta: MessageMeta) => Promise<void>;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * dead-letters the message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered.
 * A write conflict runs the transaction (and the handler) again: keep the handler's effects in the session.
 */
export class InboxConsumer {
  private readonly s: string;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly subscription: EventSubscription,
    private readonly consumerName: string,
    private readonly handler: MessageHandler,
    schema = defaultSchema()
  ) {
    this.s = schemaName(schema);
  }

  /** Polls the subscription in the background until stop(). */
  start(idleDelayMs = 200): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const delivery = await this.subscription.poll().catch(() => undefined);
        if (delivery) await this.process(delivery);
        else await new Promise(r => setTimeout(r, idleDelayMs));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Processes messages until the source stays empty for idleMs; resolves to how many were processed. */
  async drain(idleMs = 1000): Promise<number> {
    let processed = 0;
    let idleSince = Date.now();
    while (Date.now() - idleSince < idleMs) {
      const delivery = await this.subscription.poll();
      if (!delivery) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      await this.process(delivery);
      processed++;
      idleSince = Date.now();
    }
    return processed;
  }

  private async process(delivery: Delivery): Promise<void> {
    const { message } = delivery;
    const span = tracer().startSpan(\`\${this.subscription.source} process\`, {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': this.subscription.system, 'messaging.destination.name': this.subscription.source, 'messaging.message.id': message.messageId }
    }, contextFrom(message.traceparent));
    const db = this.pool.db(this.s);
    try {
      await inTransaction(this.pool, async session => {
        const inbox = db.collection('ghk_inbox');
        if (await inbox.findOne({ consumer: this.consumerName, message_id: message.messageId }, { session })) return;
        await inbox.insertOne({ consumer: this.consumerName, message_id: message.messageId, processed_at: new Date() }, { session });
        await this.handler(JSON.parse(message.body.toString('utf8')), {
          messageId: message.messageId,
          tenantId: message.tenantId,
          eventType: message.eventType,
          session,
          db
        });
      });
      await delivery.ack();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      await delivery.deadLetter().catch(() => undefined);
    } finally {
      span.end();
    }
  }
}
`;

const SAGA_TS = (ext: string) => `import type { Pool } from './db${ext}';
import { defaultSchema, schemaName } from './schema${ext}';

export interface SagaStep {
  name: string;
  action: () => Promise<void>;
  compensate: () => Promise<void>;
}

export type SagaStatus = 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED';

interface SagaRow {
  _id: string;
  tenant_id: string;
  status: SagaStatus;
  completed_steps: string;
  updated_at: Date;
}

/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed
 * steps are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
export class SagaOrchestrator {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = defaultSchema()) {
    this.s = schemaName(schema);
  }

  private get sagas() {
    return this.pool.db(this.s).collection<SagaRow>('ghk_sagas');
  }

  async run(sagaId: string, tenantId: string, steps: SagaStep[]): Promise<SagaStatus> {
    await this.sagas.updateOne({ _id: sagaId }, { $setOnInsert: { tenant_id: tenantId, status: 'RUNNING', completed_steps: '', updated_at: new Date() } }, { upsert: true })
      .catch((err: { code?: number }) => { if (err.code !== 11000) throw err; }); // a concurrent run created it
    const row = await this.sagas.findOne({ _id: sagaId, tenant_id: tenantId });
    const completed: string[] = row?.completed_steps ? row.completed_steps.split(',') : [];
    for (const step of steps) {
      if (completed.includes(step.name)) continue;
      try {
        await step.action();
        completed.push(step.name);
        await this.save(sagaId, 'RUNNING', completed);
      } catch {
        await this.save(sagaId, 'COMPENSATING', completed);
        for (const name of [...completed].reverse()) {
          await steps.find(s => s.name === name)!.compensate();
          completed.splice(completed.indexOf(name), 1);
          await this.save(sagaId, 'COMPENSATING', completed);
        }
        await this.save(sagaId, 'COMPENSATED', completed);
        return 'COMPENSATED';
      }
    }
    await this.save(sagaId, 'COMPLETED', completed);
    return 'COMPLETED';
  }

  async status(sagaId: string): Promise<{ status: SagaStatus; completedSteps: string[] } | undefined> {
    const row = await this.sagas.findOne({ _id: sagaId });
    return row ? { status: row.status, completedSteps: row.completed_steps ? row.completed_steps.split(',') : [] } : undefined;
  }

  private async save(sagaId: string, status: SagaStatus, completed: string[]): Promise<void> {
    await this.sagas.updateOne({ _id: sagaId }, { $set: { status, completed_steps: completed.join(','), updated_at: new Date() } });
  }
}
`;

/** [PostgreSQL text, MongoDB text] pairs in the files that are kept (tests, application layer). */
const STATEMENTS: [RegExp | string, string][] = [
  // Readiness.
  [/(this\.)?pool\.query\('SELECT 1'\)/g, '$1pool.ping()'],
  // HTTP integration tests.
  ["const { rows } = await pool.query('SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1', [id]);",
    "const rows = await pool.db().collection('ghk_outbox').find({ aggregate_id: id }, { projection: { _id: 0, tenant_id: 1 } }).toArray();"],
  // Runtime integration tests.
  [/const count = async \(table: string, where = 'true', params: unknown\[\] = \[\]\) =>\n\s+Number\(\(await pool\.query\(`SELECT count\(\*\)::int AS n FROM \$\{schema\}\.\$\{table\} WHERE \$\{where\}`, params\)\)\.rows\[0\]\.n\);/,
    'const count = (collection: string, filter: Record<string, unknown> = {}) => pool.db(schema).collection(collection).countDocuments(filter);'],
  [/count\('(\w+)', '(\w+) = \$1', \[([^\]]+)\]\)/g, "count('$1', { $2: $3 })"],
  [/count\('(\w+)', '(\w+) IS NULL'\)/g, "count('$1', { $2: null })"],
  ['await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);', 'await pool.db(schema).dropDatabase();'],
  ['const row = (await pool.query(`SELECT traceparent FROM ${schema}.ghk_outbox`)).rows[0];', "const row = (await pool.db(schema).collection('ghk_outbox').findOne({}))!;"],
  ['runtime (PostgreSQL + event broker)', 'runtime (MongoDB + event broker)'],
  ['against PostgreSQL and the selected broker', 'against MongoDB and the selected broker']
];

/**
 * Adapts a generated NestJS / Express project (PostgreSQL kernel) to MongoDB. `esm`: import specifiers
 * carry ".js" (NestJS 12).
 */
export function mongoizeTsProject(files: File[], esm: boolean): File[] {
  const ext = esm ? '.js' : '';
  const out = files.map(f => {
    if (!/\.ts$/.test(f.filename)) return f;
    switch (f.filename) {
      case 'src/runtime/schema.ts': return { ...f, content: SCHEMA_TS(ext) };
      case 'src/runtime/outbox-relay.ts': return { ...f, content: RELAY_TS(ext) };
      case 'src/runtime/inbox-consumer.ts': return { ...f, content: INBOX_TS(ext) };
      case 'src/runtime/saga.ts': return { ...f, content: SAGA_TS(ext) };
      case 'src/runtime/command-service.ts': return { ...f, content: commandService(f.content, ext) };
    }
    let content = f.content.replace(/from 'pg'/g, `from '${runtimeModule(f.filename, 'db', ext)}'`);
    for (const [pg, mongo] of STATEMENTS) content = typeof pg === 'string' ? content.split(pg).join(mongo) : content.replace(pg, mongo);
    return { ...f, content };
  });
  return [...out, { filename: 'src/runtime/db.ts', content: DB_TS }];
}

/** Keeps the generated aggregate table and types; replaces the class and the pg import. */
function commandService(content: string, ext: string): string {
  return content
    .replace("import type { Pool } from 'pg';", `import { inTransaction, type Pool } from './db${ext}';`)
    .replace(/import \{ schemaName \} from '\.\/schema(\.js)?';/, `import { defaultSchema, schemaName } from './schema${ext}';`)
    .replace(/\/\*\*\n \* Executes a command in one transaction[\s\S]*$/, () => `/**
 * Executes a command in one MongoDB transaction: idempotency lookup, aggregate load, domain logic,
 * aggregate save and outbox insert. A domain error aborts everything; a concurrent writer makes it run again.
 */
${COMMAND_SERVICE_CLASS}`);
}
