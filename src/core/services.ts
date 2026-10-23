/* ==========================================================================
   gherkin-ai-cli - Services for the runtime integration tests

   A private Docker network with PostgreSQL and RabbitMQ, the project's broker
   (Pub/Sub or Service Bus emulator, Kafka) and any `sandbox.services`,
   reachable from the test container by name (`postgres`, `rabbitmq`, ...).
   Used by `ghk verify --services` and by the golden builds, with the same
   broker recipes.
   ========================================================================== */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const RABBITMQ_IMAGE = 'rabbitmq:4-alpine';

export interface ExtraService {
  name: string;
  image: string;
  /** Variables for the service container. */
  environment?: Record<string, string>;
  /** Variables for the test container (e.g. S3_ENDPOINT). */
  env?: Record<string, string>;
  /** Command (and arguments) that replaces the image default, e.g. an emulator start command. */
  command?: string[];
  /** Readiness probe run inside the container with docker exec (exit 0 = ready). */
  ready?: string[];
  /** Ready once the container log contains this text (images without a probe tool). */
  readyLog?: string;
  /** Files mounted read-only into the container: container path -> content (e.g. an emulator config). */
  files?: Record<string, string>;
}

/** Google Cloud Pub/Sub emulator, selected in the tests with GHK_BROKER=pubsub. */
export const PUBSUB_EMULATOR: ExtraService = {
  name: 'pubsub',
  image: 'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators',
  command: ['gcloud', 'beta', 'emulators', 'pubsub', 'start', '--host-port=0.0.0.0:8085', '--project=ghk-local'],
  ready: ['curl', '-sf', 'http://localhost:8085'],
  env: { GHK_BROKER: 'pubsub', PUBSUB_EMULATOR_HOST: 'pubsub:8085', PUBSUB_PROJECT_ID: 'ghk-local' }
};

/** Single-node Kafka (KRaft); the image is KAFKA_IMAGE of src/generators/deploy/broker-env.ts. */
export const KAFKA_BROKER: ExtraService = {
  name: 'kafka',
  image: 'apache/kafka:4.1.0',
  environment: {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
    KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0'
  },
  ready: ['/opt/kafka/bin/kafka-broker-api-versions.sh', '--bootstrap-server', 'localhost:9092'],
  env: { GHK_BROKER: 'kafka', KAFKA_BOOTSTRAP_SERVERS: 'kafka:9092' }
};

const SQL_EDGE_PASSWORD = 'Ghk-Local-2026!';

/**
 * Azure Service Bus emulator config. Its entities are fixed at start-up, so it declares the topology of the
 * runtime tests ("it") and the service's own (named after the project, like the runtime's default topology).
 */
function serviceBusConfig(prefixes: string[]): string {
  const subscription = (name: string) => ({
    Name: name,
    Properties: { DeadLetteringOnMessageExpiration: false, DefaultMessageTimeToLive: 'PT1H', LockDuration: 'PT1M', MaxDeliveryCount: 10, ForwardDeadLetteredMessagesTo: '', ForwardTo: '', RequiresSession: false },
    Rules: []
  });
  const topic = (name: string, sub: string) => ({
    Name: name,
    Properties: { DefaultMessageTimeToLive: 'PT1H', DuplicateDetectionHistoryTimeWindow: 'PT20S', RequiresDuplicateDetection: false },
    Subscriptions: [subscription(sub)]
  });
  return JSON.stringify({
    UserConfig: {
      Namespaces: [{ Name: 'sbemulatorns', Queues: [], Topics: prefixes.flatMap(p => [topic(`${p}.events`, `${p}.consumer`), topic(`${p}.dlx`, `${p}.dlq`)]) }],
      Logging: { Type: 'File' }
    }
  }, null, 2);
}

/** Azure Service Bus emulator and the SQL Edge database it needs, selected in the tests with GHK_BROKER=servicebus. */
export function serviceBusEmulator(service: string): ExtraService[] {
  return [
    {
      name: 'sqledge',
      image: 'mcr.microsoft.com/azure-sql-edge:latest',
      environment: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: SQL_EDGE_PASSWORD },
      readyLog: 'SQL Server is now ready for client connections'
    },
    {
      name: 'servicebus',
      image: 'mcr.microsoft.com/azure-messaging/servicebus-emulator:latest',
      environment: { SQL_SERVER: 'sqledge', MSSQL_SA_PASSWORD: SQL_EDGE_PASSWORD, ACCEPT_EULA: 'Y' },
      files: { '/ServiceBus_Emulator/ConfigFiles/Config.json': serviceBusConfig(['it', service]) },
      readyLog: 'Emulator Service is Successfully Up!',
      env: {
        GHK_BROKER: 'servicebus',
        SERVICEBUS_CONNECTION_STRING: 'Endpoint=sb://servicebus;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
      }
    }
  ];
}

/**
 * The containers a runtime broker needs next to PostgreSQL and RabbitMQ (RabbitMQ itself needs none).
 * `service` is the topology prefix: the project name in kebab case.
 */
export function brokerServices(broker: 'rabbitmq' | 'pubsub' | 'servicebus' | 'kafka', service: string): ExtraService[] {
  switch (broker) {
    case 'pubsub': return [PUBSUB_EMULATOR];
    case 'kafka': return [KAFKA_BROKER];
    case 'servicebus': return serviceBusEmulator(service);
    default: return [];
  }
}

export interface RunningServices {
  network: string;
  /** DATABASE_URL, AMQP_URL and the extra services' variables, for the test container. */
  env: Record<string, string>;
  stop: () => void;
}

type Docker = (args: string[]) => { code: number; out: string };

const defaultDocker: Docker = args => {
  const res = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { code: res.status ?? 1, out: `${res.stdout || ''}${res.stderr || ''}` };
};

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(docker: Docker, description: string, check: () => boolean, container: string, timeoutMs: number): void {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    sleep(1000);
  }
  // Include the service's own log so a CI failure explains itself.
  const logs = docker(['logs', '--tail', '60', container]).out;
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs / 1000}s${logs ? `\n--- ${description} log (last 60 lines) ---\n${logs}` : ''}`);
}

/**
 * PostgreSQL that only accepts TLS connections (hostssl), like managed databases that enforce it: a self-signed
 * certificate made at start-up, so clients must connect with sslmode=require (encrypted, not verified).
 */
const POSTGRES_TLS_COMMAND = ['sh', '-c', [
  'apk add -q --no-cache openssl > /dev/null',
  'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=postgres -keyout /tmp/server.key -out /tmp/server.crt 2> /dev/null',
  "printf 'local all all trust\\nhostssl all all all scram-sha-256\\n' > /tmp/pg_hba.conf",
  'chown postgres /tmp/server.key /tmp/server.crt /tmp/pg_hba.conf && chmod 600 /tmp/server.key',
  'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key -c hba_file=/tmp/pg_hba.conf'
].join(' && ')];

/**
 * Starts PostgreSQL, RabbitMQ and the extra services on a fresh network. Always call stop().
 * `postgresTls`: PostgreSQL refuses plaintext connections and DATABASE_URL carries sslmode=require.
 */
export function startServices(label: string, extra: ExtraService[] = [], opts: { docker?: Docker; timeoutMs?: number; postgresTls?: boolean } = {}): RunningServices {
  const docker = opts.docker ?? defaultDocker;
  const timeoutMs = opts.timeoutMs ?? 180000;
  const id = `${label.replace(/[^a-z0-9-]/gi, '').toLowerCase()}-${Date.now().toString(36)}`;
  const network = `ghk-net-${id}`;
  const pg = `ghk-pg-${id}`;
  const mq = `ghk-mq-${id}`;
  const containers = [pg, mq, ...extra.map(s => `ghk-${s.name}-${id}`)];
  const stop = () => {
    docker(['rm', '-f', ...containers]);
    docker(['network', 'rm', network]);
  };
  const env: Record<string, string> = {
    DATABASE_URL: `postgres://postgres:ghk@postgres:5432/postgres${opts.postgresTls ? '?sslmode=require' : ''}`,
    AMQP_URL: 'amqp://ghk:ghk@rabbitmq:5672'
  };
  try {
    if (docker(['network', 'create', network]).code !== 0) throw new Error(`cannot create network ${network}`);
    const pgRun = docker(['run', '-d', '--name', pg, '--network', network, '--network-alias', 'postgres', '-e', 'POSTGRES_PASSWORD=ghk', POSTGRES_IMAGE,
      ...(opts.postgresTls ? POSTGRES_TLS_COMMAND : [])]);
    if (pgRun.code !== 0) throw new Error(`cannot start PostgreSQL: ${pgRun.out}`);
    const mqRun = docker(['run', '-d', '--name', mq, '--network', network, '--network-alias', 'rabbitmq', '-e', 'RABBITMQ_DEFAULT_USER=ghk', '-e', 'RABBITMQ_DEFAULT_PASS=ghk', RABBITMQ_IMAGE]);
    if (mqRun.code !== 0) throw new Error(`cannot start RabbitMQ: ${mqRun.out}`);
    // Extra services start in order, each ready before the next (an emulator may need its database first).
    for (const s of extra) {
      const container = `ghk-${s.name}-${id}`;
      const mounts = Object.entries(s.files ?? {}).flatMap(([target, content]) => {
        const host = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghk-svc-')), path.basename(target));
        fs.writeFileSync(host, content);
        return ['-v', `${host}:${target}:ro`];
      });
      const run = docker(['run', '-d', '--name', container, '--network', network, '--network-alias', s.name, ...mounts,
        ...Object.entries(s.environment ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), s.image, ...(s.command ?? [])]);
      if (run.code !== 0) throw new Error(`cannot start ${s.name}: ${run.out}`);
      Object.assign(env, s.env ?? {});
      if (s.ready) waitFor(docker, s.name, () => docker(['exec', container, ...s.ready!]).code === 0, container, timeoutMs);
      if (s.readyLog) waitFor(docker, s.name, () => docker(['logs', container]).out.includes(s.readyLog!), container, timeoutMs);
    }
    waitFor(docker, 'PostgreSQL', () => docker(['exec', pg, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1']).code === 0, pg, timeoutMs);
    // Probe as the rabbitmq user: the image sets HOME=/var/lib/rabbitmq, so a root probe that runs before
    // the server creates .erlang.cookie writes it root-only and the server then fails to start (eacces).
    waitFor(docker, 'RabbitMQ', () => docker(['exec', '-u', 'rabbitmq', mq, 'rabbitmq-diagnostics', '-q', 'check_port_connectivity']).code === 0, mq, timeoutMs);
  } catch (err) {
    stop();
    throw err;
  }
  return { network, env, stop };
}
