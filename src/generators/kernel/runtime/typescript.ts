/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for TypeScript (NestJS, Express)
   pg + amqplib + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface TsRuntimeFile {
  filename: string;
  content: string;
}

/** Runtime dependencies the generated package.json must declare. */
export const TS_RUNTIME_DEPENDENCIES = {
  pg: '^8.16.0',
  amqplib: '^2.1.0',
  '@opentelemetry/api': '^1.9.0',
  '@opentelemetry/core': '^2.1.0',
  '@opentelemetry/sdk-trace-base': '^2.1.0'
};
export const TS_RUNTIME_DEV_DEPENDENCIES = { '@types/pg': '^8.15.0' };

/**
 * @param aggregateImport module specifier of the domain aggregate, relative to src/runtime/
 */
export function renderTsRuntime(m: DomainModel, aggregateImport: string): TsRuntimeFile[] {
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const sql = JSON.stringify(RUNTIME_SCHEMA_SQL, null, 2);

  const telemetry = `// W3C trace-context helpers. Spans go to the globally registered tracer provider
// (configure exporters with the standard OTEL_* environment variables).
import { context, trace, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();
type Carrier = Record<string, unknown>;

export const tracer = () => trace.getTracer('${m.kebab}');

/** Context whose parent is the span described by an incoming traceparent header. */
export function contextFrom(traceparent?: string | null): Context {
  if (!traceparent) return context.active();
  return propagator.extract(context.active(), { traceparent }, {
    get: (carrier: Carrier, key: string) => (typeof carrier[key] === 'string' ? (carrier[key] as string) : undefined),
    keys: (carrier: Carrier) => Object.keys(carrier)
  });
}

/** traceparent header value for a context (undefined when it carries no span). */
export function traceparentOf(ctx: Context): string | undefined {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, { set: (c: Record<string, string>, key: string, value: string) => { c[key] = value; } });
  return carrier.traceparent;
}
`;

  const schema = `import type { Pool } from 'pg';

const STATEMENTS: string[] = ${sql};

${RLS_NOTE.split('\n').map(l => l.replace(/^-- ?/, '// ')).join('\n')}

/** Validated schema identifier (the tests use one schema per test). */
export function schemaName(schema = 'public'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(\`Invalid schema name: \${schema}\`);
  return schema;
}

/** Creates the runtime tables (idempotent). */
export async function migrate(pool: Pool, schema = 'public'): Promise<void> {
  const s = schemaName(schema);
  for (const statement of STATEMENTS) await pool.query(statement.split('${SCHEMA_TOKEN}').join(s));
}
`;

  const commandService = `import { randomUUID } from 'crypto';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { ${A}, DomainValidationError, type ${m.pascal}Command, type ${m.pascal}DomainEvent, type ${m.pascal}State } from '${aggregateImport}';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

const AGGREGATE_TYPE = '${m.pascal}';

const COMMANDS: Record<string, (aggregate: ${A}, command: ${m.pascal}Command) => ${m.pascal}DomainEvent> = {
${m.commands.map(c => `  ${c.snake}: (a, c) => a.${c.method}(c)`).join(',\n')}
};

export interface CommandRequest {
  tenantId: string;
  aggregateId: string;
  command: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Incoming W3C traceparent (e.g. from the HTTP request). */
  traceparent?: string;
}

export interface CommandResult {
  status: 'created' | 'replayed' | 'in-progress';
  aggregateId: string;
  eventType?: string;
  version?: number;
}

/**
 * Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE),
 * domain logic, aggregate save and outbox insert. A domain error rolls everything back.
 */
export class CommandService {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = 'public') {
    this.s = schemaName(schema);
  }

  async handle(req: CommandRequest): Promise<CommandResult> {
    if (!req.tenantId) throw new DomainValidationError('tenantId is required');
    const parent = contextFrom(req.traceparent);
    const span = tracer().startSpan(\`${m.pascal}.\${req.command}\`, {
      kind: SpanKind.INTERNAL,
      attributes: { 'tenant.id': req.tenantId, 'aggregate.id': req.aggregateId }
    }, parent);
    const ctx = trace.setSpan(parent, span);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (req.idempotencyKey) {
        const claim = await client.query(\`INSERT INTO \${this.s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING\`, [req.tenantId, req.idempotencyKey]);
        if (claim.rowCount === 0) {
          const { rows } = await client.query(\`SELECT status, response FROM \${this.s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2\`, [req.tenantId, req.idempotencyKey]);
          await client.query('COMMIT');
          if (rows[0]?.status === 'COMPLETED') return { ...(JSON.parse(rows[0].response) as CommandResult), status: 'replayed' };
          return { status: 'in-progress', aggregateId: req.aggregateId };
        }
      }
      const { rows } = await client.query(\`SELECT state, version FROM \${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE\`, [req.tenantId, AGGREGATE_TYPE, req.aggregateId]);
      const aggregate = rows[0]
        ? ${A}.restore(req.aggregateId, rows[0].state as ${m.pascal}State, Number(rows[0].version))
        : new ${A}(req.aggregateId);
      const handler = COMMANDS[req.command];
      if (!handler) throw new DomainValidationError(\`Unknown command \${req.command}\`);
      const event = handler(aggregate, { id: req.aggregateId, payload: req.payload ?? {} });

      await client.query(
        \`INSERT INTO \${this.s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()\`,
        [req.tenantId, AGGREGATE_TYPE, req.aggregateId, aggregate.state, aggregate.version]
      );
      await client.query(
        \`INSERT INTO \${this.s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)\`,
        [randomUUID(), req.tenantId, req.aggregateId, event.type, JSON.stringify(event), traceparentOf(ctx) ?? null]
      );
      const result: CommandResult = { status: 'created', aggregateId: req.aggregateId, eventType: event.type, version: event.version };
      if (req.idempotencyKey) {
        await client.query(\`UPDATE \${this.s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2\`, [req.tenantId, req.idempotencyKey, JSON.stringify(result)]);
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      client.release();
      span.end();
    }
  }

  /** The aggregate as tenant \`tenantId\` sees it (undefined for other tenants' aggregates). */
  async load(tenantId: string, aggregateId: string): Promise<{ state: string; version: number } | undefined> {
    const { rows } = await this.pool.query(\`SELECT state, version FROM \${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3\`, [tenantId, AGGREGATE_TYPE, aggregateId]);
    return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : undefined;
  }
}
`;

  const relay = `import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Channel, ConfirmChannel } from 'amqplib';
import type { Pool } from 'pg';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

export interface Topology {
  exchange: string;
  queue: string;
  dlx: string;
  dlq: string;
}

/** Default topology for this feature (pass a prefix to isolate environments or tests). */
export function topology(prefix = '${m.kebab}'): Topology {
  return { exchange: \`\${prefix}.events\`, queue: \`\${prefix}.consumer\`, dlx: \`\${prefix}.dlx\`, dlq: \`\${prefix}.dlq\` };
}
export const DEFAULT_TOPOLOGY: Topology = ${JSON.stringify(t)};

/** Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ. */
export async function declareTopology(channel: Channel, t: Topology = DEFAULT_TOPOLOGY): Promise<void> {
  await channel.assertExchange(t.exchange, 'topic', { durable: true });
  await channel.assertExchange(t.dlx, 'fanout', { durable: true });
  await channel.assertQueue(t.dlq, { durable: true });
  await channel.bindQueue(t.dlq, t.dlx, '');
  await channel.assertQueue(t.queue, { durable: true, arguments: { 'x-dead-letter-exchange': t.dlx } });
  await channel.bindQueue(t.queue, t.exchange, '#');
}

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease,
 * so concurrent relays never publish the same row; publisher confirms guarantee delivery
 * to the broker before a row is marked published.
 */
export class OutboxRelay {
  private readonly s: string;

  constructor(
    private readonly pool: Pool,
    private readonly channel: ConfirmChannel,
    private readonly exchange: string = DEFAULT_TOPOLOGY.exchange,
    schema = 'public',
    private readonly leaseSeconds = ${LEASE_SECONDS},
    private readonly maxAttempts = ${MAX_PUBLISH_ATTEMPTS}
  ) {
    this.s = schemaName(schema);
  }

  async publishBatch(workerId: string, limit = 50): Promise<number> {
    const { rows } = await this.pool.query(
      \`UPDATE \${this.s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM \${this.s}.ghk_outbox
         WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id, aggregate_id, event_type, payload, traceparent, attempts\`,
      [workerId, this.leaseSeconds, limit]
    );
    let published = 0;
    for (const row of rows) {
      const parent = contextFrom(row.traceparent);
      const span = tracer().startSpan(\`\${this.exchange} publish\`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': this.exchange, 'messaging.message.id': row.id, 'tenant.id': row.tenant_id }
      }, parent);
      try {
        const headers: Record<string, string> = { tenant_id: row.tenant_id };
        const traceparent = traceparentOf(trace.setSpan(parent, span));
        if (traceparent) headers.traceparent = traceparent;
        await new Promise<void>((resolve, reject) => {
          this.channel.publish(this.exchange, row.event_type, Buffer.from(row.payload), {
            messageId: row.id, persistent: true, contentType: 'application/json', type: row.event_type, headers
          }, err => (err ? reject(err) : resolve()));
        });
        await this.pool.query(\`UPDATE \${this.s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2\`, [row.id, workerId]);
        published++;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        await this.pool.query(
          \`UPDATE \${this.s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1\`,
          [row.id, String((err as Error).message ?? err), this.maxAttempts]
        );
      } finally {
        span.end();
      }
    }
    return published;
  }
}
`;

  const inbox = `import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Pool, PoolClient } from 'pg';
import { schemaName } from './schema';
import { contextFrom, tracer } from './telemetry';

export interface MessageMeta {
  messageId: string;
  tenantId?: string;
  eventType?: string;
  /** Transaction the inbox record is written in; use it for the handler's own writes. */
  client: PoolClient;
}

export type MessageHandler = (event: Record<string, unknown>, meta: MessageMeta) => Promise<void>;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
 */
export class InboxConsumer {
  private readonly s: string;
  private consumerTag?: string;

  constructor(
    private readonly pool: Pool,
    private readonly channel: Channel,
    private readonly queue: string,
    private readonly consumerName: string,
    private readonly handler: MessageHandler,
    schema = 'public'
  ) {
    this.s = schemaName(schema);
  }

  async start(prefetch = 10): Promise<void> {
    await this.channel.prefetch(prefetch);
    const { consumerTag } = await this.channel.consume(this.queue, msg => {
      if (msg) void this.onMessage(msg);
    });
    this.consumerTag = consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.channel.cancel(this.consumerTag);
  }

  private async onMessage(msg: ConsumeMessage): Promise<void> {
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    const span = tracer().startSpan(\`\${this.queue} process\`, {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': this.queue, 'messaging.message.id': String(msg.properties.messageId) }
    }, contextFrom(typeof headers.traceparent === 'string' ? headers.traceparent : undefined));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const messageId = String(msg.properties.messageId);
      const first = await client.query(\`INSERT INTO \${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING\`, [this.consumerName, messageId]);
      if (first.rowCount === 1) {
        await this.handler(JSON.parse(msg.content.toString('utf8')), {
          messageId,
          tenantId: typeof headers.tenant_id === 'string' ? headers.tenant_id : undefined,
          eventType: msg.properties.type,
          client
        });
      }
      await client.query('COMMIT');
      this.channel.ack(msg);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      this.channel.nack(msg, false, false);
    } finally {
      client.release();
      span.end();
    }
  }
}
`;

  const saga = `import type { Pool } from 'pg';
import { schemaName } from './schema';

export interface SagaStep {
  name: string;
  action: () => Promise<void>;
  compensate: () => Promise<void>;
}

export type SagaStatus = 'RUNNING' | 'COMPLETED' | 'COMPENSATING' | 'COMPENSATED';

/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed
 * steps are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
export class SagaOrchestrator {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = 'public') {
    this.s = schemaName(schema);
  }

  async run(sagaId: string, tenantId: string, steps: SagaStep[]): Promise<SagaStatus> {
    await this.pool.query(\`INSERT INTO \${this.s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING\`, [sagaId, tenantId]);
    const { rows } = await this.pool.query(\`SELECT completed_steps FROM \${this.s}.ghk_sagas WHERE id = $1 AND tenant_id = $2\`, [sagaId, tenantId]);
    const completed: string[] = rows[0]?.completed_steps ? String(rows[0].completed_steps).split(',') : [];
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
    const { rows } = await this.pool.query(\`SELECT status, completed_steps FROM \${this.s}.ghk_sagas WHERE id = $1\`, [sagaId]);
    return rows[0] ? { status: rows[0].status, completedSteps: rows[0].completed_steps ? String(rows[0].completed_steps).split(',') : [] } : undefined;
  }

  private async save(sagaId: string, status: SagaStatus, completed: string[]): Promise<void> {
    await this.pool.query(\`UPDATE \${this.s}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1\`, [sagaId, status, completed.join(',')]);
  }
}
`;

  const index = `export * from './schema';
export * from './telemetry';
export * from './command-service';
export * from './outbox-relay';
export * from './inbox-consumer';
export * from './saga';
`;

  const first = m.commands[0];
  const spec = `// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
// Requires DATABASE_URL and AMQP_URL. Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { SpanKind, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as amqp from 'amqplib';
import { Pool } from 'pg';
import { CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, declareTopology, migrate, topology, type Topology } from '../../src/runtime/index';

const { DATABASE_URL, AMQP_URL } = process.env;
if (!DATABASE_URL || !AMQP_URL) throw new Error('Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).');

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const COMMAND = '${first.snake}';
const EVENT = '${first.event}';
let pool: Pool;
let connection: amqp.ChannelModel;
let schema: string;
let t: Topology;
const uid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await pool.query(\`SELECT count(*)::int AS n FROM \${schema}.\${table} WHERE \${where}\`, params)).rows[0].n);
const until = async (check: () => Promise<boolean>, timeoutMs = 10000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 50));
  }
};
const drainQueue = async (channel: amqp.Channel, queue: string) => {
  const messages: amqp.GetMessage[] = [];
  for (let m = await channel.get(queue, { noAck: true }); m; m = await channel.get(queue, { noAck: true })) messages.push(m);
  return messages;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
  connection = await amqp.connect(AMQP_URL);
});

afterAll(async () => {
  await connection?.close();
  await pool?.end();
});

beforeEach(async () => {
  schema = \`it_\${uid()}\`;
  t = topology(\`it-\${uid()}\`);
  await migrate(pool, schema);
  exporter.reset();
});

afterEach(async () => {
  await pool.query(\`DROP SCHEMA IF EXISTS \${schema} CASCADE\`);
});

describe('${m.pascal} runtime (PostgreSQL + RabbitMQ)', () => {
  it('IT1 persists the aggregate and exactly one outbox row atomically; a domain error persists nothing', async () => {
    const service = new CommandService(pool, schema);
    const result = await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND });
    expect(result).toMatchObject({ status: 'created', eventType: EVENT, version: 1 });
    expect(await service.load('t1', 'agg-1')).toMatchObject({ version: 1 });
    expect(await count('ghk_outbox', 'aggregate_id = $1', ['agg-1'])).toBe(1);

    await expect(service.handle({ tenantId: 't1', aggregateId: 'agg-2', command: 'no_such_command', idempotencyKey: 'k-fail' })).rejects.toThrow(/Unknown command/);
    expect(await service.load('t1', 'agg-2')).toBeUndefined();
    expect(await count('ghk_outbox', 'aggregate_id = $1', ['agg-2'])).toBe(0);
    expect(await count('ghk_idempotency', 'key = $1', ['k-fail'])).toBe(0);
  });

  it('IT2 five concurrent requests with one idempotency key produce one effect and identical responses', async () => {
    const service = new CommandService(pool, schema);
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, idempotencyKey: 'key-1' })));
    expect(await count('ghk_outbox')).toBe(1);
    expect(await service.load('t1', 'agg-1')).toMatchObject({ version: 1 });
    expect(results.filter(r => r.status === 'created')).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ eventType: EVENT, version: 1 });
  });

  it('IT3 two concurrent relays publish every outbox event exactly once', async () => {
    const service = new CommandService(pool, schema);
    for (let i = 0; i < 20; i++) await service.handle({ tenantId: 't1', aggregateId: \`agg-\${i}\`, command: COMMAND });
    const setup = await connection.createChannel();
    await declareTopology(setup, t);
    const [a, b] = await Promise.all([connection.createConfirmChannel(), connection.createConfirmChannel()]);
    const drain = async (relay: OutboxRelay, worker: string) => {
      let total = 0;
      for (let n = await relay.publishBatch(worker, 3); n > 0; n = await relay.publishBatch(worker, 3)) total += n;
      return total;
    };
    const [na, nb] = await Promise.all([drain(new OutboxRelay(pool, a, t.exchange, schema), 'relay-a'), drain(new OutboxRelay(pool, b, t.exchange, schema), 'relay-b')]);
    expect(na + nb).toBe(20);
    expect(await count('ghk_outbox', 'published_at IS NULL')).toBe(0);
    await until(async () => (await setup.checkQueue(t.queue)).messageCount === 20);
    const ids = (await drainQueue(setup, t.queue)).map(m => m.properties.messageId);
    expect(new Set(ids).size).toBe(20);
    await Promise.all([a.close(), b.close(), setup.close()]);
  });

  it('IT4 tenants cannot read or change each other\\'s aggregates', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 'tenant-a', aggregateId: 'shared-id', command: COMMAND });
    expect(await service.load('tenant-b', 'shared-id')).toBeUndefined();
    await service.handle({ tenantId: 'tenant-b', aggregateId: 'shared-id', command: COMMAND });
    expect(await service.load('tenant-a', 'shared-id')).toMatchObject({ version: 1 });
    expect(await service.load('tenant-b', 'shared-id')).toMatchObject({ version: 1 });
    expect(await count('ghk_outbox', 'tenant_id = $1', ['tenant-a'])).toBe(1);
  });

  it('IT5 a failing saga step compensates the completed steps in reverse order', async () => {
    const saga = new SagaOrchestrator(pool, schema);
    const log: string[] = [];
    const step = (name: string, fail = false) => ({
      name,
      action: async () => { if (fail) throw new Error(\`\${name} failed\`); log.push(\`do:\${name}\`); },
      compensate: async () => { log.push(\`undo:\${name}\`); }
    });
    expect(await saga.run('saga-1', 't1', [step('reserve'), step('charge'), step('ship', true)])).toBe('COMPENSATED');
    expect(log).toEqual(['do:reserve', 'do:charge', 'undo:charge', 'undo:reserve']);
    expect(await saga.status('saga-1')).toEqual({ status: 'COMPENSATED', completedSteps: [] });
    expect(await saga.run('saga-2', 't1', [step('reserve'), step('charge')])).toBe('COMPLETED');
  });

  it('IT6 a redelivered message is handled once and a failing message is dead-lettered', async () => {
    const channel = await connection.createChannel();
    await declareTopology(channel, t);
    const handled: string[] = [];
    const consumer = new InboxConsumer(pool, channel, t.queue, 'it-consumer', async (event, meta) => {
      if (event.poison) throw new Error('cannot process');
      handled.push(meta.messageId);
    }, schema);
    await consumer.start();
    const publish = (messageId: string, body: object) => channel.publish(t.exchange, 'Test', Buffer.from(JSON.stringify(body)), { messageId, headers: { tenant_id: 't1' } });
    publish('m-1', { ok: true });
    publish('m-1', { ok: true });
    publish('m-poison', { poison: true });
    await until(async () => (await channel.checkQueue(t.dlq)).messageCount === 1 && handled.length === 1);
    await new Promise(r => setTimeout(r, 300));
    expect(handled).toEqual(['m-1']);
    expect(await count('ghk_inbox', 'consumer = $1', ['it-consumer'])).toBe(1);
    const dead = await drainQueue(channel, t.dlq);
    expect(dead.map(m => m.properties.messageId)).toEqual(['m-poison']);
    await consumer.stop();
    await channel.close();
  });

  it('IT7 the incoming trace context flows through command, outbox, publish and consume spans', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, traceparent: '${TEST_TRACEPARENT}' });
    const row = (await pool.query(\`SELECT traceparent FROM \${schema}.ghk_outbox\`)).rows[0];
    expect(row.traceparent).toContain('${TEST_TRACE_ID}');

    const channel = await connection.createConfirmChannel();
    await declareTopology(channel, t);
    const received: { traceparent?: unknown }[] = [];
    const consumer = new InboxConsumer(pool, channel, t.queue, 'trace-consumer', async () => { received.push({}); }, schema);
    await consumer.start();
    expect(await new OutboxRelay(pool, channel, t.exchange, schema).publishBatch('relay', 10)).toBe(1);
    await until(async () => received.length === 1 && exporter.getFinishedSpans().some(s => s.kind === SpanKind.CONSUMER));
    await consumer.stop();
    await channel.close();

    const spans = exporter.getFinishedSpans();
    const byKind = (kind: SpanKind) => spans.find(s => s.kind === kind)!;
    const command = byKind(SpanKind.INTERNAL);
    expect(command.spanContext().traceId).toBe('${TEST_TRACE_ID}');
    expect(command.parentSpanContext?.spanId).toBe('${TEST_PARENT_SPAN_ID}');
    expect(byKind(SpanKind.PRODUCER).spanContext().traceId).toBe('${TEST_TRACE_ID}');
    expect(byKind(SpanKind.CONSUMER).spanContext().traceId).toBe('${TEST_TRACE_ID}');
    expect(byKind(SpanKind.CONSUMER).parentSpanContext?.spanId).toBe(byKind(SpanKind.PRODUCER).spanContext().spanId);
  });
});
`;

  return [
    { filename: 'src/runtime/telemetry.ts', content: telemetry },
    { filename: 'src/runtime/schema.ts', content: schema },
    { filename: 'src/runtime/command-service.ts', content: commandService },
    { filename: 'src/runtime/outbox-relay.ts', content: relay },
    { filename: 'src/runtime/inbox-consumer.ts', content: inbox },
    { filename: 'src/runtime/saga.ts', content: saga },
    { filename: 'src/runtime/index.ts', content: index },
    { filename: 'test/integration/runtime.int-spec.ts', content: spec }
  ];
}
