/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for TypeScript (NestJS, Express)
   pg + amqplib + OpenTelemetry. Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor, usesServiceBus } from './jvm';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface TsRuntimeFile {
  filename: string;
  content: string;
}

/** Runtime dependencies the generated package.json must declare. */
export const TS_RUNTIME_DEPENDENCIES = {
  pg: '^8.16.0',
  amqplib: '^2.1.0',
  '@opentelemetry/api': '^1.9.1',
  '@opentelemetry/core': '^2.12.0',
  '@opentelemetry/sdk-trace-base': '^2.12.0'
};
export const TS_RUNTIME_DEV_DEPENDENCIES = { '@types/pg': '^8.15.0' };

/** Azure SDK packages, added only when the Service Bus adapter is generated (stack.messaging "servicebus"). */
export const TS_SERVICEBUS_DEPENDENCIES = { '@azure/service-bus': '^7.10.0', '@azure/identity': '^4.14.0' };

/** Runtime dependencies for a stack.messaging value. */
export function tsRuntimeDependencies(messaging?: string): Record<string, string> {
  return usesServiceBus(messaging) ? { ...TS_RUNTIME_DEPENDENCIES, ...TS_SERVICEBUS_DEPENDENCIES } : TS_RUNTIME_DEPENDENCIES;
}

/** Another aggregate of the same service and its module specifier relative to src/runtime/. */
export interface TsSiblingAggregate {
  m: DomainModel;
  aggregateImport: string;
}

/**
 * @param aggregateImport module specifier of the domain aggregate, relative to src/runtime/
 * @param siblings the service's other aggregates: the command service handles all of them
 */
export function renderTsRuntime(m: DomainModel, aggregateImport: string, siblings: TsSiblingAggregate[] = [], { messaging = undefined as string | undefined } = {}): TsRuntimeFile[] {
  const t = topology(m);
  const serviceBus = usesServiceBus(messaging);
  const defaultBroker = defaultBrokerFor(messaging);
  const A = `${m.pascal}Aggregate`;
  const sql = JSON.stringify(RUNTIME_SCHEMA_SQL, null, 2);
  const all = [{ m, aggregateImport }, ...siblings];

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
import { DomainValidationError } from '${aggregateImport}';
${all.map(s => `import { ${s.m.pascal}Aggregate, type ${s.m.pascal}Command, type ${s.m.pascal}State } from '${s.aggregateImport}';`).join('\n')}
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

interface LoadedAggregate {
  readonly state: string;
  readonly version: number;
}

type DomainCommand = { id: string; payload: Record<string, unknown> };

/** How the command service creates, restores and runs commands on one aggregate type. */
interface AggregateRuntime {
  create(id: string): LoadedAggregate;
  restore(id: string, state: string, version: number): LoadedAggregate;
  commands: Record<string, (aggregate: LoadedAggregate, command: DomainCommand) => { type: string; version: number }>;
}

/** Every aggregate of this service, by aggregate type (one per feature). */
const AGGREGATES: Record<string, AggregateRuntime> = {
${all.map(s => `  ${s.m.pascal}: {
    create: id => new ${s.m.pascal}Aggregate(id),
    restore: (id, state, version) => ${s.m.pascal}Aggregate.restore(id, state as ${s.m.pascal}State, version),
    commands: {
${s.m.commands.map(c => `      ${c.snake}: (a, c) => (a as ${s.m.pascal}Aggregate).${c.method}(c as ${s.m.pascal}Command)`).join(',\n')}
    }
  }`).join(',\n')}
};

/** Aggregate type used when a request does not name one. */
export const DEFAULT_AGGREGATE = '${m.pascal}';

export interface CommandRequest {
  tenantId: string;
  /** Aggregate type (feature), e.g. '${m.pascal}'; defaults to DEFAULT_AGGREGATE. */
  aggregateType?: string;
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
    const aggregateType = req.aggregateType ?? DEFAULT_AGGREGATE;
    const kind = AGGREGATES[aggregateType];
    if (!kind) throw new DomainValidationError(\`Unknown aggregate type \${aggregateType}\`);
    const parent = contextFrom(req.traceparent);
    const span = tracer().startSpan(\`\${aggregateType}.\${req.command}\`, {
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
      const { rows } = await client.query(\`SELECT state, version FROM \${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE\`, [req.tenantId, aggregateType, req.aggregateId]);
      const aggregate = rows[0]
        ? kind.restore(req.aggregateId, String(rows[0].state), Number(rows[0].version))
        : kind.create(req.aggregateId);
      const handler = kind.commands[req.command];
      if (!handler) throw new DomainValidationError(\`Unknown command \${req.command}\`);
      const event = handler(aggregate, { id: req.aggregateId, payload: req.payload ?? {} });

      await client.query(
        \`INSERT INTO \${this.s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()\`,
        [req.tenantId, aggregateType, req.aggregateId, aggregate.state, aggregate.version]
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
  async load(tenantId: string, aggregateId: string, aggregateType = DEFAULT_AGGREGATE): Promise<{ state: string; version: number } | undefined> {
    const { rows } = await this.pool.query(\`SELECT state, version FROM \${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3\`, [tenantId, aggregateType, aggregateId]);
    return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : undefined;
  }
}
`;

  const broker = `// The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on
// any cloud: GHK_BROKER=rabbitmq (AMQP_URL), pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT;
// PUBSUB_EMULATOR_HOST for the emulator)${serviceBus ? ' or servicebus (SERVICEBUS_NAMESPACE or SERVICEBUS_CONNECTION_STRING)' : ''}.
// Without GHK_BROKER the configured variables decide, then stack.messaging.
import * as amqp from 'amqplib';
${serviceBus ? "import { ServiceBusBroker } from './servicebus-broker';\n" : ''}
/** Event bus destinations: publish to exchange (topic), consume from queue (subscription); dead letters go to dlx, read from dlq. */
export interface Topology {
  exchange: string;
  queue: string;
  dlx: string;
  dlq: string;
}

/** Default topology for this service (pass a prefix to isolate environments or tests). */
export function topology(prefix = '${t.exchange.replace(/\.events$/, '')}'): Topology {
  return { exchange: \`\${prefix}.events\`, queue: \`\${prefix}.consumer\`, dlx: \`\${prefix}.dlx\`, dlq: \`\${prefix}.dlq\` };
}
export const DEFAULT_TOPOLOGY: Topology = ${JSON.stringify(t)};

/** A domain event on the wire, independent of the broker. */
export interface BrokerMessage {
  messageId: string;
  eventType?: string;
  tenantId?: string;
  traceparent?: string;
  body: Buffer;
}

/** Publishes to one destination; publish resolves only once the broker has durably accepted the message. */
export interface EventPublisher {
  readonly system: string;
  readonly destination: string;
  publish(message: BrokerMessage): Promise<void>;
  close(): Promise<void>;
}

/** A received message: ack() once processed; deadLetter() moves it to the DLQ (it is not redelivered). */
export interface Delivery {
  message: BrokerMessage;
  ack(): Promise<void>;
  deadLetter(): Promise<void>;
}

/** Pulls messages from one queue / subscription. */
export interface EventSubscription {
  readonly system: string;
  readonly source: string;
  /** The next waiting message, or undefined when there is none. */
  poll(): Promise<Delivery | undefined>;
  close(): Promise<void>;
}

export interface Broker {
  readonly system: string;
  /** False when topics cannot be created at run time (Service Bus emulator: fixed Config.json). */
  readonly dynamicTopology: boolean;
  /** Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code. */
  declare(t: Topology): Promise<void>;
  publisher(destination: string): Promise<EventPublisher>;
  /** @param t where dead-lettered messages go */
  subscribe(source: string, t: Topology): Promise<EventSubscription>;
  close(): Promise<void>;
}

/** Broker of the generated configuration (stack.messaging). */
export const DEFAULT_BROKER = '${defaultBroker}';

export function brokerKind(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GHK_BROKER?.trim()) return env.GHK_BROKER.trim().toLowerCase();
  if (env.AMQP_URL) return 'rabbitmq';
  if (env.PUBSUB_PROJECT_ID || env.PUBSUB_EMULATOR_HOST) return 'pubsub';
  if (env.SERVICEBUS_CONNECTION_STRING || env.SERVICEBUS_NAMESPACE) return 'servicebus';
  return DEFAULT_BROKER;
}

/** Whether the variables of the selected broker are set. */
export function brokerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  switch (brokerKind(env)) {
    case 'pubsub': return Boolean(env.PUBSUB_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT);
    case 'servicebus': return Boolean(env.SERVICEBUS_CONNECTION_STRING || env.SERVICEBUS_NAMESPACE);
    default: return Boolean(env.AMQP_URL);
  }
}

export async function connectBroker(env: NodeJS.ProcessEnv = process.env): Promise<Broker> {
  const kind = brokerKind(env);
  switch (kind) {
    case 'rabbitmq':
      if (!env.AMQP_URL) throw new Error('AMQP_URL is not set (amqp://user:password@host:5672)');
      return RabbitMqBroker.connect(env.AMQP_URL);
    case 'pubsub':
      return PubSubBroker.fromEnv(env);
    case 'servicebus':
      ${serviceBus ? 'return ServiceBusBroker.fromEnv(env);' : "throw new Error('The Azure Service Bus adapter is not generated: set stack.messaging to \"servicebus\" and regenerate');"}
    default:
      throw new Error(\`Unsupported GHK_BROKER: \${kind} (rabbitmq, pubsub, servicebus)\`);
  }
}

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

/** RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX. */
export class RabbitMqBroker implements Broker {
  readonly system = 'rabbitmq';
  readonly dynamicTopology = true;

  constructor(private readonly connection: AmqpConnection) {}

  static async connect(url: string): Promise<RabbitMqBroker> {
    // A busy host can delay the AMQP handshake: retry before failing.
    for (let attempt = 1; ; attempt++) {
      try {
        return new RabbitMqBroker(await amqp.connect(url));
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  async declare(t: Topology): Promise<void> {
    const channel = await this.connection.createChannel();
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    await channel.assertExchange(t.dlx, 'fanout', { durable: true });
    await channel.assertQueue(t.dlq, { durable: true });
    await channel.bindQueue(t.dlq, t.dlx, '');
    await channel.assertQueue(t.queue, { durable: true, arguments: { 'x-dead-letter-exchange': t.dlx } });
    await channel.bindQueue(t.queue, t.exchange, '#');
    await channel.close();
  }

  async publisher(exchange: string): Promise<EventPublisher> {
    const channel = await this.connection.createConfirmChannel();
    return {
      system: this.system,
      destination: exchange,
      publish: m => new Promise<void>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (m.tenantId) headers.tenant_id = m.tenantId;
        if (m.traceparent) headers.traceparent = m.traceparent;
        channel.publish(exchange, m.eventType ?? '', m.body, {
          messageId: m.messageId, persistent: true, contentType: 'application/json', type: m.eventType, headers
        }, err => (err ? reject(err) : resolve()));
      }),
      close: async () => { await channel.close().catch(() => undefined); }
    };
  }

  async subscribe(queue: string): Promise<EventSubscription> {
    const channel = await this.connection.createChannel();
    return {
      system: this.system,
      source: queue,
      poll: async () => {
        const msg = await channel.get(queue, { noAck: false });
        if (!msg) return undefined;
        const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
        return {
          message: { messageId: String(msg.properties.messageId), eventType: msg.properties.type, tenantId: text(headers.tenant_id), traceparent: text(headers.traceparent), body: msg.content },
          ack: async () => channel.ack(msg),
          // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
          deadLetter: async () => channel.nack(msg, false, false)
        };
      },
      close: async () => { await channel.close().catch(() => undefined); }
    };
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => undefined);
  }
}

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
 * subscriptions for the queue and the DLQ. publish resolves once Pub/Sub has stored the message. A failed
 * message is dead-lettered by the consumer: published to the DLX topic, then acknowledged.
 * Auth: none against the emulator; otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server token of the
 * workload's service account (Cloud Run, GKE workload identity).
 */
export class PubSubBroker implements Broker {
  readonly system = 'gcp_pubsub';
  readonly dynamicTopology = true;
  private readonly root: string;
  private readonly emulator: boolean;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly project: string, emulatorHost?: string) {
    this.emulator = Boolean(emulatorHost);
    this.root = \`\${this.emulator ? \`http://\${emulatorHost}\` : 'https://pubsub.googleapis.com'}/v1/projects/\${project}\`;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PubSubBroker {
    const project = env.PUBSUB_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
    return new PubSubBroker(project, env.PUBSUB_EMULATOR_HOST);
  }

  private async bearer(): Promise<string | undefined> {
    if (this.emulator) return undefined;
    if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (!this.token || Date.now() > this.tokenExpiresAt) {
      const res = await fetch(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } });
      const body = (await res.json()) as { access_token: string; expires_in: number };
      this.token = body.access_token;
      this.tokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000;
    }
    return this.token;
  }

  /** Calls the API; a status listed in accepted resolves to undefined instead of failing. */
  private async call(method: string, path: string, body?: unknown, accepted: number[] = []): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const bearer = await this.bearer();
    if (bearer) headers.authorization = \`Bearer \${bearer}\`;
    const res = await fetch(\`\${this.root}\${path}\`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    if (accepted.includes(res.status)) return undefined;
    throw new Error(\`Pub/Sub \${method} \${path} failed: \${res.status} \${await res.text()}\`);
  }

  async declare(t: Topology): Promise<void> {
    // 409: it already exists (created earlier or by infrastructure as code).
    await this.call('PUT', \`/topics/\${t.exchange}\`, {}, [409]);
    await this.call('PUT', \`/topics/\${t.dlx}\`, {}, [409]);
    await this.call('PUT', \`/subscriptions/\${t.queue}\`, { topic: \`projects/\${this.project}/topics/\${t.exchange}\`, ackDeadlineSeconds: 60 }, [409]);
    await this.call('PUT', \`/subscriptions/\${t.dlq}\`, { topic: \`projects/\${this.project}/topics/\${t.dlx}\`, ackDeadlineSeconds: 60 }, [409]);
  }

  private async publishTo(topic: string, m: BrokerMessage): Promise<void> {
    const attributes: Record<string, string> = { ghk_message_id: m.messageId };
    if (m.eventType) attributes.event_type = m.eventType;
    if (m.tenantId) attributes.tenant_id = m.tenantId;
    if (m.traceparent) attributes.traceparent = m.traceparent;
    const res = await this.call('POST', \`/topics/\${topic}:publish\`, { messages: [{ data: m.body.toString('base64'), attributes }] });
    if (res?.messageIds?.length !== 1) throw new Error(\`Pub/Sub did not accept message \${m.messageId}\`);
  }

  async publisher(topic: string): Promise<EventPublisher> {
    return { system: this.system, destination: topic, publish: m => this.publishTo(topic, m), close: async () => undefined };
  }

  async subscribe(subscription: string, t: Topology): Promise<EventSubscription> {
    return {
      system: this.system,
      source: subscription,
      poll: async () => {
        const res = await this.call('POST', \`/subscriptions/\${subscription}:pull\`, { maxMessages: 1, returnImmediately: true });
        const received = res?.receivedMessages?.[0];
        if (!received) return undefined;
        const attrs: Record<string, string> = received.message.attributes ?? {};
        const message: BrokerMessage = {
          messageId: attrs.ghk_message_id ?? received.message.messageId,
          eventType: attrs.event_type,
          tenantId: attrs.tenant_id,
          traceparent: attrs.traceparent,
          body: Buffer.from(received.message.data ?? '', 'base64')
        };
        const ack = async () => { await this.call('POST', \`/subscriptions/\${subscription}:acknowledge\`, { ackIds: [received.ackId] }); };
        return { message, ack, deadLetter: async () => { await this.publishTo(t.dlx, message); await ack(); } };
      },
      close: async () => undefined
    };
  }

  async close(): Promise<void> {}
}
`;

  const serviceBusTs = `// Azure Service Bus (official SDK, AMQP): topics for the exchange and the DLX, subscriptions for the queue and
// the DLQ. Auth: SERVICEBUS_CONNECTION_STRING (shared access key; the emulator) or SERVICEBUS_NAMESPACE
// (e.g. orders.servicebus.windows.net) with Microsoft Entra ID (managed identity in Container Apps / AKS).
// A failed message is dead-lettered by the consumer: sent to the DLX topic, then completed.
import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusAdministrationClient, ServiceBusClient, type ServiceBusMessage, type ServiceBusSender } from '@azure/service-bus';
import type { Broker, BrokerMessage, EventPublisher, EventSubscription, Topology } from './broker';

const toMessage = (m: BrokerMessage): ServiceBusMessage => ({
  body: m.body,
  messageId: m.messageId,
  contentType: 'application/json',
  subject: m.eventType,
  applicationProperties: {
    ...(m.tenantId ? { tenant_id: m.tenantId } : {}),
    ...(m.traceparent ? { ghk_traceparent: m.traceparent } : {})
  }
});

export class ServiceBusBroker implements Broker {
  readonly system = 'servicebus';
  readonly dynamicTopology: boolean;
  private readonly client: ServiceBusClient;

  constructor(private readonly connectionString?: string, private readonly namespace?: string) {
    this.client = connectionString ? new ServiceBusClient(connectionString) : new ServiceBusClient(namespace!, new DefaultAzureCredential());
    this.dynamicTopology = !(connectionString ?? '').includes('UseDevelopmentEmulator=true');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ServiceBusBroker {
    if (!env.SERVICEBUS_CONNECTION_STRING && !env.SERVICEBUS_NAMESPACE) throw new Error('SERVICEBUS_CONNECTION_STRING or SERVICEBUS_NAMESPACE is not set');
    return new ServiceBusBroker(env.SERVICEBUS_CONNECTION_STRING || undefined, env.SERVICEBUS_NAMESPACE);
  }

  async declare(t: Topology): Promise<void> {
    // The emulator only knows the entities of its Config.json; in Azure they usually come from Terraform.
    if (!this.dynamicTopology) return;
    const admin = this.connectionString
      ? new ServiceBusAdministrationClient(this.connectionString)
      : new ServiceBusAdministrationClient(this.namespace!, new DefaultAzureCredential());
    for (const topic of [t.exchange, t.dlx]) {
      if (!(await admin.topicExists(topic))) await admin.createTopic(topic);
    }
    if (!(await admin.subscriptionExists(t.exchange, t.queue))) await admin.createSubscription(t.exchange, t.queue);
    if (!(await admin.subscriptionExists(t.dlx, t.dlq))) await admin.createSubscription(t.dlx, t.dlq);
  }

  async publisher(topic: string): Promise<EventPublisher> {
    const sender = this.client.createSender(topic);
    return { system: this.system, destination: topic, publish: m => sender.sendMessages(toMessage(m)), close: () => sender.close() };
  }

  async subscribe(subscription: string, t: Topology): Promise<EventSubscription> {
    const topic = subscription === t.dlq ? t.dlx : t.exchange;
    const receiver = this.client.createReceiver(topic, subscription, { receiveMode: 'peekLock' });
    let deadLetters: ServiceBusSender | undefined;
    return {
      system: this.system,
      source: subscription,
      poll: async () => {
        const [msg] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 500 });
        if (!msg) return undefined;
        const props = msg.applicationProperties ?? {};
        const body = Buffer.isBuffer(msg.body) ? msg.body : Buffer.from(typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body));
        const message: BrokerMessage = {
          messageId: String(msg.messageId),
          eventType: msg.subject,
          tenantId: props.tenant_id === undefined ? undefined : String(props.tenant_id),
          traceparent: props.ghk_traceparent === undefined ? undefined : String(props.ghk_traceparent),
          body
        };
        return {
          message,
          ack: () => receiver.completeMessage(msg),
          deadLetter: async () => {
            deadLetters ??= this.client.createSender(t.dlx);
            await deadLetters.sendMessages(toMessage(message));
            await receiver.completeMessage(msg);
          }
        };
      },
      close: async () => {
        await deadLetters?.close();
        await receiver.close();
      }
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
`;

  const relay = `import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { EventPublisher } from './broker';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease,
 * so concurrent relays never publish the same row; the publisher resolves only once the broker
 * has accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before a row is
 * marked published. Use one relay (and publisher) per worker.
 */
export class OutboxRelay {
  private readonly s: string;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: EventPublisher,
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
      const span = tracer().startSpan(\`\${this.publisher.destination} publish\`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': this.publisher.system, 'messaging.destination.name': this.publisher.destination, 'messaging.message.id': row.id, 'tenant.id': row.tenant_id }
      }, parent);
      try {
        const traceparent = traceparentOf(trace.setSpan(parent, span));
        const payload = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
        await this.publisher.publish({ messageId: row.id, eventType: row.event_type, tenantId: row.tenant_id, traceparent, body: Buffer.from(payload) });
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
import type { Pool, PoolClient } from 'pg';
import type { Delivery, EventSubscription } from './broker';
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
 * dead-letters the message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered.
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
    schema = 'public'
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const first = await client.query(\`INSERT INTO \${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING\`, [this.consumerName, message.messageId]);
      if (first.rowCount === 1) {
        await this.handler(JSON.parse(message.body.toString('utf8')), {
          messageId: message.messageId,
          tenantId: message.tenantId,
          eventType: message.eventType,
          client
        });
      }
      await client.query('COMMIT');
      await delivery.ack();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      await delivery.deadLetter().catch(() => undefined);
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
export * from './broker';
export * from './outbox-relay';
export * from './inbox-consumer';
export * from './saga';
`;

  const first = m.commands[0];
  const spec = `// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and the selected broker
// (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST], servicebus).
// Requires DATABASE_URL. Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { SpanKind, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Pool } from 'pg';
import { CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, brokerConfigured, connectBroker, migrate, topology, type Broker, type BrokerMessage, type Topology } from '../../src/runtime/index';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL || !brokerConfigured()) throw new Error('Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).');

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const COMMAND = '${first.snake}';
const EVENT = '${first.event}';
let pool: Pool;
let broker: Broker;
let schema: string;
let t: Topology;
const uid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await pool.query(\`SELECT count(*)::int AS n FROM \${schema}.\${table} WHERE \${where}\`, params)).rows[0].n);
/** Receives and acknowledges messages until the expected number arrived and the source stays quiet for 500 ms (10 s at most). */
const receive = async (source: string, expected: number): Promise<BrokerMessage[]> => {
  const out: BrokerMessage[] = [];
  const subscription = await broker.subscribe(source, t);
  const deadline = Date.now() + 10000;
  let quietSince = Date.now();
  try {
    while (Date.now() < deadline && (out.length < expected || Date.now() - quietSince < 500)) {
      const delivery = await subscription.poll();
      if (!delivery) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      out.push(delivery.message);
      await delivery.ack();
      quietSince = Date.now();
    }
  } finally {
    await subscription.close();
  }
  return out;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
  broker = await connectBroker();
});

afterAll(async () => {
  await broker?.close();
  await pool?.end();
});

beforeEach(async () => {
  schema = \`it_\${uid()}\`;
  // Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
  t = broker.dynamicTopology ? topology(\`it-\${uid()}\`) : topology('it');
  await migrate(pool, schema);
  await broker.declare(t);
  if (!broker.dynamicTopology) {
    await receive(t.queue, 0);
    await receive(t.dlq, 0);
  }
  exporter.reset();
});

afterEach(async () => {
  await pool.query(\`DROP SCHEMA IF EXISTS \${schema} CASCADE\`);
});

describe('${m.pascal} runtime (PostgreSQL + event broker)', () => {
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
    const [a, b] = await Promise.all([broker.publisher(t.exchange), broker.publisher(t.exchange)]);
    const drain = async (relay: OutboxRelay, worker: string) => {
      let total = 0;
      for (let n = await relay.publishBatch(worker, 3); n > 0; n = await relay.publishBatch(worker, 3)) total += n;
      return total;
    };
    const [na, nb] = await Promise.all([drain(new OutboxRelay(pool, a, schema), 'relay-a'), drain(new OutboxRelay(pool, b, schema), 'relay-b')]);
    await Promise.all([a.close(), b.close()]);
    expect(na + nb).toBe(20);
    expect(await count('ghk_outbox', 'published_at IS NULL')).toBe(0);
    const received = await receive(t.queue, 20);
    expect(received).toHaveLength(20);
    expect(new Set(received.map(m => m.messageId)).size).toBe(20);
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
    const handled: string[] = [];
    const publisher = await broker.publisher(t.exchange);
    const subscription = await broker.subscribe(t.queue, t);
    const consumer = new InboxConsumer(pool, subscription, 'it-consumer', async (event, meta) => {
      if (event.poison) throw new Error('cannot process');
      handled.push(meta.messageId);
    }, schema);
    const publish = (messageId: string, body: object) =>
      publisher.publish({ messageId, eventType: 'Test', tenantId: 't1', body: Buffer.from(JSON.stringify(body)) });
    await publish('m-1', { ok: true });
    await publish('m-1', { ok: true });
    await publish('m-poison', { poison: true });
    await consumer.drain(1000);
    await Promise.all([publisher.close(), subscription.close()]);
    expect(handled).toEqual(['m-1']);
    expect(await count('ghk_inbox', 'consumer = $1', ['it-consumer'])).toBe(1);
    const dead = await receive(t.dlq, 1);
    expect(dead.map(m => m.messageId)).toEqual(['m-poison']);
  });

  it('IT7 the incoming trace context flows through command, outbox, publish and consume spans', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, traceparent: '${TEST_TRACEPARENT}' });
    const row = (await pool.query(\`SELECT traceparent FROM \${schema}.ghk_outbox\`)).rows[0];
    expect(row.traceparent).toContain('${TEST_TRACE_ID}');

    const publisher = await broker.publisher(t.exchange);
    expect(await new OutboxRelay(pool, publisher, schema).publishBatch('relay', 10)).toBe(1);
    await publisher.close();
    const received: string[] = [];
    const subscription = await broker.subscribe(t.queue, t);
    await new InboxConsumer(pool, subscription, 'trace-consumer', async (_event, meta) => { received.push(meta.messageId); }, schema).drain(1000);
    await subscription.close();
    expect(received).toHaveLength(1);

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
    { filename: 'src/runtime/broker.ts', content: broker },
    ...(serviceBus ? [{ filename: 'src/runtime/servicebus-broker.ts', content: serviceBusTs }] : []),
    { filename: 'src/runtime/outbox-relay.ts', content: relay },
    { filename: 'src/runtime/inbox-consumer.ts', content: inbox },
    { filename: 'src/runtime/saga.ts', content: saga },
    { filename: 'src/runtime/index.ts', content: index },
    { filename: 'test/integration/runtime.int-spec.ts', content: spec }
  ];
}
