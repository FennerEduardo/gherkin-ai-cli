/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for PHP (Laravel)
   PDO pgsql + php-amqplib + OpenTelemetry PHP. Contract: docs/RUNTIME-KERNEL.md.
   Needs the pdo_pgsql and sockets extensions (see PHP_RUNTIME_EXTENSIONS).
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface PhpRuntimeFile {
  filename: string;
  content: string;
}

export const PHP_RUNTIME_REQUIRE = {
  'ext-pdo_pgsql': '*',
  'ext-sockets': '*',
  'php-amqplib/php-amqplib': '^3.7',
  'open-telemetry/api': '^1.1',
  'open-telemetry/sdk': '^1.2'
};

/** Installs the PHP extensions the runtime needs in the official php / composer Alpine images. */
export const PHP_RUNTIME_EXTENSIONS = 'apk add --no-cache $PHPIZE_DEPS postgresql-dev linux-headers > /dev/null && docker-php-ext-install pdo_pgsql sockets > /dev/null';

const php = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function renderPhpRuntime(m: DomainModel): PhpRuntimeFile[] {
  const t = topology(m);
  const domainNs = `App\\Domain\\${m.pascal}`;
  const A = `${m.pascal}Aggregate`;
  const head = `<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Runtime;\n\n`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `        ${php(s)},`).join('\n');

  const database = `${head}use PDO;

/** PDO connections from a libpq-style URL: postgres://user:password@host:5432/database */
final class Database
{
    public static function connect(string $databaseUrl): PDO
    {
        $url = parse_url($databaseUrl);
        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'], $url['port'] ?? 5432, ltrim($url['path'] ?? '', '/'));
        return new PDO($dsn, isset($url['user']) ? urldecode($url['user']) : null, isset($url['pass']) ? urldecode($url['pass']) : null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }

    /** @param list<mixed> $params */
    public static function exec(PDO $pdo, string $sql, array $params = []): int
    {
        $statement = $pdo->prepare($sql);
        $statement->execute($params);
        return $statement->rowCount();
    }

    /**
     * @param list<mixed> $params
     * @return list<array<string, mixed>>
     */
    public static function rows(PDO $pdo, string $sql, array $params = []): array
    {
        $statement = $pdo->prepare($sql);
        $statement->execute($params);
        return $statement->fetchAll();
    }
}
`;

  const schema = `${head}/** Runtime tables (docs/RUNTIME-KERNEL.md). */
final class Schema
{
    private const STATEMENTS = [
${statements}
    ];

${RLS_NOTE.split('\n').map(l => `    ${l.replace(/^-- ?/, '// ')}`).join('\n')}

    public static function name(string $schema = 'public'): string
    {
        $s = $schema === '' ? 'public' : $schema;
        if (preg_match('/^[a-z_][a-z0-9_]*$/', $s) !== 1) {
            throw new \\InvalidArgumentException("Invalid schema name: {$s}");
        }
        return $s;
    }

    public static function migrate(string $databaseUrl, string $schema = 'public'): void
    {
        $s = self::name($schema);
        $pdo = Database::connect($databaseUrl);
        foreach (self::STATEMENTS as $statement) {
            $pdo->exec(str_replace(${php(SCHEMA_TOKEN)}, $s, $statement));
        }
    }
}
`;

  const telemetry = `${head}use OpenTelemetry\\API\\Globals;
use OpenTelemetry\\API\\Trace\\Propagation\\TraceContextPropagator;
use OpenTelemetry\\API\\Trace\\SpanInterface;
use OpenTelemetry\\API\\Trace\\TracerInterface;
use OpenTelemetry\\Context\\Context;
use OpenTelemetry\\Context\\ContextInterface;

/** W3C trace-context helpers; spans go to the global tracer provider (configure exporters with OTEL_*). */
final class Telemetry
{
    public static function tracer(): TracerInterface
    {
        return Globals::tracerProvider()->getTracer(${php(m.kebab)});
    }

    /** Context whose parent is the span described by an incoming traceparent header. */
    public static function contextFrom(?string $traceparent): ContextInterface
    {
        if ($traceparent === null || $traceparent === '') {
            return Context::getCurrent();
        }
        return TraceContextPropagator::getInstance()->extract(['traceparent' => $traceparent]);
    }

    /** traceparent header value for a span (null when the span is invalid). */
    public static function traceparentOf(SpanInterface $span, ContextInterface $parent): ?string
    {
        $carrier = [];
        TraceContextPropagator::getInstance()->inject($carrier, null, $span->storeInContext($parent));
        return $carrier['traceparent'] ?? null;
    }
}
`;

  const commandService = `${head}use ${domainNs}\\${A};
use ${domainNs}\\${m.pascal}Command;
use ${domainNs}\\${m.pascal}State;
use ${domainNs}\\DomainValidationException;
use OpenTelemetry\\API\\Trace\\SpanKind;
use OpenTelemetry\\API\\Trace\\StatusCode;
use PDO;

/**
 * Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
 * logic, aggregate save and outbox insert. A domain error rolls back everything.
 */
final class CommandService
{
    private const AGGREGATE_TYPE = ${php(m.pascal)};
    private const COMMANDS = [
${m.commands.map(c => `        ${php(c.snake)} => ${php(c.method)},`).join('\n')}
    ];

    private readonly string $s;

    public function __construct(private readonly string $databaseUrl, string $schema = 'public')
    {
        $this->s = Schema::name($schema);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{status: string, aggregateId: string, eventType: ?string, version: ?int}
     */
    public function handle(string $tenantId, string $aggregateId, string $command, array $payload = [], ?string $idempotencyKey = null, ?string $traceparent = null): array
    {
        if ($tenantId === '') {
            throw new DomainValidationException('tenantId is required');
        }
        $parent = Telemetry::contextFrom($traceparent);
        $span = Telemetry::tracer()->spanBuilder("${m.pascal}.{$command}")->setParent($parent)->setSpanKind(SpanKind::KIND_INTERNAL)
            ->setAttribute('tenant.id', $tenantId)->setAttribute('aggregate.id', $aggregateId)->startSpan();
        $pdo = Database::connect($this->databaseUrl);
        try {
            $pdo->beginTransaction();
            $result = $this->execute($pdo, $tenantId, $aggregateId, $command, $payload, $idempotencyKey, Telemetry::traceparentOf($span, $parent));
            $pdo->commit();
            return $result;
        } catch (\\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $span->recordException($e);
            $span->setStatus(StatusCode::STATUS_ERROR, $e->getMessage());
            throw $e;
        } finally {
            $span->end();
        }
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{status: string, aggregateId: string, eventType: ?string, version: ?int}
     */
    private function execute(PDO $pdo, string $tenantId, string $aggregateId, string $command, array $payload, ?string $key, ?string $traceparent): array
    {
        $s = $this->s;
        if ($key !== null) {
            if (Database::exec($pdo, "INSERT INTO {$s}.ghk_idempotency (tenant_id, key, status) VALUES (?, ?, 'PROCESSING') ON CONFLICT DO NOTHING", [$tenantId, $key]) === 0) {
                $row = Database::rows($pdo, "SELECT status, response FROM {$s}.ghk_idempotency WHERE tenant_id = ? AND key = ?", [$tenantId, $key])[0] ?? null;
                if ($row !== null && $row['status'] === 'COMPLETED') {
                    return ['status' => 'replayed'] + json_decode((string) $row['response'], true);
                }
                return ['status' => 'in-progress', 'aggregateId' => $aggregateId, 'eventType' => null, 'version' => null];
            }
        }
        $row = Database::rows($pdo, "SELECT state, version FROM {$s}.ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ? FOR UPDATE",
            [$tenantId, self::AGGREGATE_TYPE, $aggregateId])[0] ?? null;
        $aggregate = $row !== null
            ? ${A}::restore($aggregateId, ${m.pascal}State::from((string) $row['state']), (int) $row['version'])
            : new ${A}($aggregateId);
        $method = self::COMMANDS[$command] ?? throw new DomainValidationException("Unknown command {$command}");
        $event = $aggregate->{$method}(new ${m.pascal}Command($aggregateId, $payload));
        Database::exec($pdo, "INSERT INTO {$s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (?, ?, ?, ?, ?) "
            . 'ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()',
            [$tenantId, self::AGGREGATE_TYPE, $aggregateId, $aggregate->state()->value, $aggregate->version()]);
        Database::exec($pdo, "INSERT INTO {$s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (?, ?, ?, ?, ?, ?)",
            [self::uuid(), $tenantId, $aggregateId, $event->type->value, json_encode($event, JSON_THROW_ON_ERROR), $traceparent]);
        $result = ['status' => 'created', 'aggregateId' => $aggregateId, 'eventType' => $event->type->value, 'version' => $event->version];
        if ($key !== null) {
            Database::exec($pdo, "UPDATE {$s}.ghk_idempotency SET status = 'COMPLETED', response = ? WHERE tenant_id = ? AND key = ?",
                [json_encode($result, JSON_THROW_ON_ERROR), $tenantId, $key]);
        }
        return $result;
    }

    /** @return array{state: string, version: int}|null The aggregate as the tenant sees it (null for other tenants'). */
    public function load(string $tenantId, string $aggregateId): ?array
    {
        $row = Database::rows(Database::connect($this->databaseUrl),
            "SELECT state, version FROM {$this->s}.ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ?",
            [$tenantId, self::AGGREGATE_TYPE, $aggregateId])[0] ?? null;
        return $row === null ? null : ['state' => (string) $row['state'], 'version' => (int) $row['version']];
    }

    public static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
`;

  const amqp = `${head}use PhpAmqpLib\\Channel\\AMQPChannel;
use PhpAmqpLib\\Connection\\AMQPStreamConnection;
use PhpAmqpLib\\Wire\\AMQPTable;

/** RabbitMQ connection and topology: topic exchange -> consumer queue dead-lettering to a fanout DLX -> DLQ. */
final class Messaging
{
    public const DEFAULT_PREFIX = ${php(m.kebab)};

    public function __construct(public readonly string $exchange, public readonly string $queue, public readonly string $dlx, public readonly string $dlq)
    {
    }

    public static function forPrefix(string $prefix = self::DEFAULT_PREFIX): self
    {
        return new self("{$prefix}.events", "{$prefix}.consumer", "{$prefix}.dlx", "{$prefix}.dlq");
    }

    /** From an AMQP URL: amqp://user:password@host:5672/vhost */
    public static function connect(string $amqpUrl): AMQPStreamConnection
    {
        $url = parse_url($amqpUrl);
        $vhost = isset($url['path']) && $url['path'] !== '/' && $url['path'] !== '' ? urldecode(substr($url['path'], 1)) : '/';
        return new AMQPStreamConnection($url['host'], $url['port'] ?? 5672, urldecode($url['user'] ?? 'guest'), urldecode($url['pass'] ?? 'guest'), $vhost);
    }

    public function declare(AMQPChannel $channel): void
    {
        $channel->exchange_declare($this->exchange, 'topic', false, true, false);
        $channel->exchange_declare($this->dlx, 'fanout', false, true, false);
        $channel->queue_declare($this->dlq, false, true, false, false);
        $channel->queue_bind($this->dlq, $this->dlx, '');
        $channel->queue_declare($this->queue, false, true, false, false, false, new AMQPTable(['x-dead-letter-exchange' => $this->dlx]));
        $channel->queue_bind($this->queue, $this->exchange, '#');
    }

    public static function messageCount(AMQPChannel $channel, string $queue): int
    {
        [, $count] = $channel->queue_declare($queue, true);
        return (int) $count;
    }
}
`;

  const relay = `${head}use OpenTelemetry\\API\\Trace\\SpanKind;
use OpenTelemetry\\API\\Trace\\StatusCode;
use PhpAmqpLib\\Channel\\AMQPChannel;
use PhpAmqpLib\\Message\\AMQPMessage;
use PhpAmqpLib\\Wire\\AMQPTable;

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
 * concurrent relays never publish the same row; publisher confirms guarantee delivery to the broker
 * before a row is marked published. Use one relay (and channel) per process.
 */
final class OutboxRelay
{
    private readonly string $s;
    private bool $nacked = false;

    public function __construct(
        private readonly string $databaseUrl,
        private readonly AMQPChannel $channel,
        private readonly string $exchange,
        string $schema = 'public',
        private readonly int $leaseSeconds = ${LEASE_SECONDS},
        private readonly int $maxAttempts = ${MAX_PUBLISH_ATTEMPTS},
    ) {
        $this->s = Schema::name($schema);
        $this->channel->confirm_select();
        $this->channel->set_nack_handler(function (): void {
            $this->nacked = true;
        });
    }

    public function publishBatch(string $workerId, int $limit = 50): int
    {
        $s = $this->s;
        $pdo = Database::connect($this->databaseUrl);
        $rows = Database::rows($pdo,
            "UPDATE {$s}.ghk_outbox SET claimed_by = ?, claimed_until = now() + make_interval(secs => ?), attempts = attempts + 1 "
            . "WHERE id IN (SELECT id FROM {$s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) "
            . 'ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent',
            [$workerId, $this->leaseSeconds, $limit]);
        $published = 0;
        foreach ($rows as $row) {
            $parent = Telemetry::contextFrom($row['traceparent']);
            $span = Telemetry::tracer()->spanBuilder("{$this->exchange} publish")->setParent($parent)->setSpanKind(SpanKind::KIND_PRODUCER)
                ->setAttribute('messaging.system', 'rabbitmq')->setAttribute('messaging.destination.name', $this->exchange)
                ->setAttribute('messaging.message.id', $row['id'])->setAttribute('tenant.id', $row['tenant_id'])->startSpan();
            try {
                $headers = ['tenant_id' => $row['tenant_id']];
                $traceparent = Telemetry::traceparentOf($span, $parent);
                if ($traceparent !== null) {
                    $headers['traceparent'] = $traceparent;
                }
                $this->nacked = false;
                $this->channel->basic_publish(new AMQPMessage((string) $row['payload'], [
                    'message_id' => $row['id'], 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                    'content_type' => 'application/json', 'type' => $row['event_type'], 'application_headers' => new AMQPTable($headers),
                ]), $this->exchange, (string) $row['event_type']);
                $this->channel->wait_for_pending_acks(10);
                if ($this->nacked) {
                    throw new \\RuntimeException("Broker rejected {$row['id']}");
                }
                Database::exec($pdo, "UPDATE {$s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = ? AND claimed_by = ?", [$row['id'], $workerId]);
                $published++;
            } catch (\\Throwable $e) {
                $span->recordException($e);
                $span->setStatus(StatusCode::STATUS_ERROR);
                Database::exec($pdo, "UPDATE {$s}.ghk_outbox SET claimed_until = NULL, last_error = ?, failed_at = CASE WHEN attempts >= ? THEN now() ELSE NULL END WHERE id = ?",
                    [$e->getMessage(), $this->maxAttempts, $row['id']]);
            } finally {
                $span->end();
            }
        }
        return $published;
    }
}
`;

  const inbox = `${head}use OpenTelemetry\\API\\Trace\\SpanKind;
use OpenTelemetry\\API\\Trace\\StatusCode;
use PhpAmqpLib\\Channel\\AMQPChannel;
use PhpAmqpLib\\Message\\AMQPMessage;
use PDO;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
 */
final class InboxConsumer
{
    private readonly string $s;

    /** @param \\Closure(array<string, mixed>, array{messageId: string, tenantId: ?string, eventType: ?string, pdo: PDO}): void $handler */
    public function __construct(
        private readonly string $databaseUrl,
        private readonly AMQPChannel $channel,
        private readonly string $queue,
        private readonly string $consumerName,
        private readonly \\Closure $handler,
        string $schema = 'public',
    ) {
        $this->s = Schema::name($schema);
    }

    /** Processes messages until the queue stays empty for $idleSeconds; returns how many were processed. */
    public function drain(float $idleSeconds = 1.0): int
    {
        $processed = 0;
        $idleSince = microtime(true);
        while (microtime(true) - $idleSince < $idleSeconds) {
            $message = $this->channel->basic_get($this->queue);
            if ($message === null) {
                usleep(50_000);
                continue;
            }
            $this->process($message);
            $processed++;
            $idleSince = microtime(true);
        }
        return $processed;
    }

    private function process(AMQPMessage $message): void
    {
        $headers = $message->has('application_headers') ? $message->get('application_headers')->getNativeData() : [];
        $messageId = $message->has('message_id') ? (string) $message->get('message_id') : '';
        $span = Telemetry::tracer()->spanBuilder("{$this->queue} process")->setParent(Telemetry::contextFrom($headers['traceparent'] ?? null))
            ->setSpanKind(SpanKind::KIND_CONSUMER)->setAttribute('messaging.system', 'rabbitmq')
            ->setAttribute('messaging.destination.name', $this->queue)->setAttribute('messaging.message.id', $messageId)->startSpan();
        $pdo = Database::connect($this->databaseUrl);
        try {
            $pdo->beginTransaction();
            if (Database::exec($pdo, "INSERT INTO {$this->s}.ghk_inbox (consumer, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [$this->consumerName, $messageId]) === 1) {
                ($this->handler)(json_decode($message->getBody(), true, 512, JSON_THROW_ON_ERROR), [
                    'messageId' => $messageId,
                    'tenantId' => $headers['tenant_id'] ?? null,
                    'eventType' => $message->has('type') ? (string) $message->get('type') : null,
                    'pdo' => $pdo,
                ]);
            }
            $pdo->commit();
            $message->ack();
        } catch (\\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $span->recordException($e);
            $span->setStatus(StatusCode::STATUS_ERROR);
            $message->reject(false);
        } finally {
            $span->end();
        }
    }
}
`;

  const saga = `${head}/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
 * are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
final class SagaOrchestrator
{
    private readonly string $s;

    public function __construct(private readonly string $databaseUrl, string $schema = 'public')
    {
        $this->s = Schema::name($schema);
    }

    /** @param list<array{name: string, action: \\Closure(): void, compensate: \\Closure(): void}> $steps */
    public function run(string $sagaId, string $tenantId, array $steps): string
    {
        $pdo = Database::connect($this->databaseUrl);
        Database::exec($pdo, "INSERT INTO {$this->s}.ghk_sagas (id, tenant_id, status) VALUES (?, ?, 'RUNNING') ON CONFLICT (id) DO NOTHING", [$sagaId, $tenantId]);
        $completed = $this->status($sagaId)['completedSteps'] ?? [];
        foreach ($steps as $step) {
            if (in_array($step['name'], $completed, true)) {
                continue;
            }
            try {
                ($step['action'])();
            } catch (\\Throwable) {
                $this->save($sagaId, 'COMPENSATING', $completed);
                foreach (array_reverse($completed) as $name) {
                    foreach ($steps as $candidate) {
                        if ($candidate['name'] === $name) {
                            ($candidate['compensate'])();
                        }
                    }
                    $completed = array_values(array_diff($completed, [$name]));
                    $this->save($sagaId, 'COMPENSATING', $completed);
                }
                $this->save($sagaId, 'COMPENSATED', $completed);
                return 'COMPENSATED';
            }
            $completed[] = $step['name'];
            $this->save($sagaId, 'RUNNING', $completed);
        }
        $this->save($sagaId, 'COMPLETED', $completed);
        return 'COMPLETED';
    }

    /** @return array{status: string, completedSteps: list<string>}|null */
    public function status(string $sagaId): ?array
    {
        $row = Database::rows(Database::connect($this->databaseUrl), "SELECT status, completed_steps FROM {$this->s}.ghk_sagas WHERE id = ?", [$sagaId])[0] ?? null;
        if ($row === null) {
            return null;
        }
        $done = (string) $row['completed_steps'];
        return ['status' => (string) $row['status'], 'completedSteps' => $done === '' ? [] : explode(',', $done)];
    }

    /** @param list<string> $completed */
    private function save(string $sagaId, string $status, array $completed): void
    {
        Database::exec(Database::connect($this->databaseUrl), "UPDATE {$this->s}.ghk_sagas SET status = ?, completed_steps = ?, updated_at = now() WHERE id = ?",
            [$status, implode(',', $completed), $sagaId]);
    }
}
`;

  // Separate processes stand in for threads in the concurrency tests.
  const worker = `<?php

declare(strict_types=1);

// Worker process for the concurrency tests (IT2, IT3): php worker.php <handle|relay> '<json args>'
require __DIR__ . '/../../vendor/autoload.php';

use App\\Runtime\\CommandService;
use App\\Runtime\\Messaging;
use App\\Runtime\\OutboxRelay;

[$mode, $json] = [$argv[1], $argv[2]];
$args = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
$databaseUrl = (string) getenv('DATABASE_URL');

if ($mode === 'handle') {
    $result = (new CommandService($databaseUrl, $args['schema']))->handle($args['tenantId'], $args['aggregateId'], $args['command'], [], $args['key'] ?? null);
    echo json_encode($result);
    exit(0);
}

$connection = Messaging::connect((string) getenv('AMQP_URL'));
$relay = new OutboxRelay($databaseUrl, $connection->channel(), $args['exchange'], $args['schema']);
$total = 0;
while (($n = $relay->publishBatch($args['worker'], 3)) > 0) {
    $total += $n;
}
$connection->close();
echo json_encode(['published' => $total]);
`;

  const first = m.commands[0];
  const test = `<?php

declare(strict_types=1);

namespace Tests\\Integration;

use App\\Domain\\${m.pascal}\\DomainValidationException;
use App\\Runtime\\CommandService;
use App\\Runtime\\Database;
use App\\Runtime\\InboxConsumer;
use App\\Runtime\\Messaging;
use App\\Runtime\\OutboxRelay;
use App\\Runtime\\SagaOrchestrator;
use App\\Runtime\\Schema;
use OpenTelemetry\\API\\Trace\\SpanKind;
use OpenTelemetry\\SDK\\Sdk;
use OpenTelemetry\\SDK\\Trace\\SpanExporter\\InMemoryExporter;
use OpenTelemetry\\SDK\\Trace\\SpanProcessor\\SimpleSpanProcessor;
use OpenTelemetry\\SDK\\Trace\\TracerProvider;
use PhpAmqpLib\\Message\\AMQPMessage;
use PhpAmqpLib\\Wire\\AMQPTable;
use PHPUnit\\Framework\\Attributes\\Group;
use PHPUnit\\Framework\\TestCase;

/** Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and AMQP_URL. */
#[Group('integration')]
final class RuntimeIntegrationTest extends TestCase
{
    private const COMMAND = ${php(first.snake)};
    private const EVENT = ${php(first.event)};
    private static InMemoryExporter $exporter;
    private string $databaseUrl;
    private string $amqpUrl;
    private string $schema;
    private Messaging $topology;

    public static function setUpBeforeClass(): void
    {
        self::$exporter = new InMemoryExporter();
        Sdk::builder()->setTracerProvider(new TracerProvider(new SimpleSpanProcessor(self::$exporter)))->buildAndRegisterGlobal();
    }

    protected function setUp(): void
    {
        $this->databaseUrl = (string) getenv('DATABASE_URL');
        $this->amqpUrl = (string) getenv('AMQP_URL');
        if ($this->databaseUrl === '' || $this->amqpUrl === '') {
            self::fail('Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).');
        }
        $uid = bin2hex(random_bytes(6));
        $this->schema = "it_{$uid}";
        $this->topology = Messaging::forPrefix("it-{$uid}");
        Schema::migrate($this->databaseUrl, $this->schema);
        self::$exporter->getStorage()->exchangeArray([]);
    }

    protected function tearDown(): void
    {
        Database::connect($this->databaseUrl)->exec("DROP SCHEMA IF EXISTS {$this->schema} CASCADE");
    }

    private function countRows(string $table, string $where = 'true', array $params = []): int
    {
        return (int) Database::rows(Database::connect($this->databaseUrl), "SELECT count(*) AS n FROM {$this->schema}.{$table} WHERE {$where}", $params)[0]['n'];
    }

    /** Runs workers in parallel processes (PHP has no threads) and returns their decoded JSON outputs. */
    private function runWorkers(string $mode, array $argsList): array
    {
        $running = [];
        foreach ($argsList as $args) {
            $process = proc_open([PHP_BINARY, __DIR__ . '/worker.php', $mode, json_encode($args)], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $running[] = [$process, $pipes];
        }
        $outputs = [];
        foreach ($running as [$process, $pipes]) {
            $stdout = stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process), "worker failed: {$stderr}");
            $outputs[] = json_decode((string) $stdout, true, 512, JSON_THROW_ON_ERROR);
        }
        return $outputs;
    }

    private static function waitFor(callable $check): void
    {
        $deadline = microtime(true) + 10;
        while (!$check()) {
            if (microtime(true) > $deadline) {
                self::fail('Timed out waiting for condition');
            }
            usleep(50_000);
        }
    }

    /** @return list<AMQPMessage> */
    private static function drainQueue($channel, string $queue): array
    {
        $messages = [];
        while (($message = $channel->basic_get($queue, true)) !== null) {
            $messages[] = $message;
        }
        return $messages;
    }

    public function testIT1AtomicWriteAndRollback(): void
    {
        $service = new CommandService($this->databaseUrl, $this->schema);
        $result = $service->handle('t1', 'agg-1', self::COMMAND);
        self::assertSame(['created', self::EVENT, 1], [$result['status'], $result['eventType'], $result['version']]);
        self::assertSame(1, $service->load('t1', 'agg-1')['version']);
        self::assertSame(1, $this->countRows('ghk_outbox', 'aggregate_id = ?', ['agg-1']));
        try {
            $service->handle('t1', 'agg-2', 'no_such_command', [], 'k-fail');
            self::fail('Expected a domain error');
        } catch (DomainValidationException $e) {
            self::assertStringContainsString('Unknown command', $e->getMessage());
        }
        self::assertNull($service->load('t1', 'agg-2'));
        self::assertSame(0, $this->countRows('ghk_outbox', 'aggregate_id = ?', ['agg-2']));
        self::assertSame(0, $this->countRows('ghk_idempotency', 'key = ?', ['k-fail']));
    }

    public function testIT2ConcurrentIdempotentRequests(): void
    {
        $args = ['schema' => $this->schema, 'tenantId' => 't1', 'aggregateId' => 'agg-1', 'command' => self::COMMAND, 'key' => 'key-1'];
        $results = $this->runWorkers('handle', array_fill(0, 5, $args));
        self::assertSame(1, $this->countRows('ghk_outbox'));
        self::assertSame(1, (new CommandService($this->databaseUrl, $this->schema))->load('t1', 'agg-1')['version']);
        self::assertCount(1, array_filter($results, fn ($r) => $r['status'] === 'created'));
        foreach ($results as $r) {
            self::assertSame([self::EVENT, 1], [$r['eventType'], $r['version']]);
        }
    }

    public function testIT3ConcurrentRelaysPublishExactlyOnce(): void
    {
        $service = new CommandService($this->databaseUrl, $this->schema);
        for ($i = 0; $i < 20; $i++) {
            $service->handle('t1', "agg-{$i}", self::COMMAND);
        }
        $connection = Messaging::connect($this->amqpUrl);
        $channel = $connection->channel();
        $this->topology->declare($channel);
        $outputs = $this->runWorkers('relay', [
            ['schema' => $this->schema, 'exchange' => $this->topology->exchange, 'worker' => 'relay-a'],
            ['schema' => $this->schema, 'exchange' => $this->topology->exchange, 'worker' => 'relay-b'],
        ]);
        self::assertSame(20, array_sum(array_column($outputs, 'published')));
        self::assertSame(0, $this->countRows('ghk_outbox', 'published_at IS NULL'));
        self::waitFor(fn () => Messaging::messageCount($channel, $this->topology->queue) === 20);
        $ids = array_map(fn (AMQPMessage $m) => $m->get('message_id'), self::drainQueue($channel, $this->topology->queue));
        self::assertCount(20, array_unique($ids));
        $connection->close();
    }

    public function testIT4TenantIsolation(): void
    {
        $service = new CommandService($this->databaseUrl, $this->schema);
        $service->handle('tenant-a', 'shared-id', self::COMMAND);
        self::assertNull($service->load('tenant-b', 'shared-id'));
        $service->handle('tenant-b', 'shared-id', self::COMMAND);
        self::assertSame(1, $service->load('tenant-a', 'shared-id')['version']);
        self::assertSame(1, $service->load('tenant-b', 'shared-id')['version']);
        self::assertSame(1, $this->countRows('ghk_outbox', 'tenant_id = ?', ['tenant-a']));
    }

    public function testIT5SagaCompensatesInReverseOrder(): void
    {
        $saga = new SagaOrchestrator($this->databaseUrl, $this->schema);
        $log = [];
        $step = function (string $name, bool $fail = false) use (&$log): array {
            return [
                'name' => $name,
                'action' => function () use ($name, $fail, &$log): void {
                    if ($fail) {
                        throw new \\RuntimeException("{$name} failed");
                    }
                    $log[] = "do:{$name}";
                },
                'compensate' => function () use ($name, &$log): void {
                    $log[] = "undo:{$name}";
                },
            ];
        };
        self::assertSame('COMPENSATED', $saga->run('saga-1', 't1', [$step('reserve'), $step('charge'), $step('ship', true)]));
        self::assertSame(['do:reserve', 'do:charge', 'undo:charge', 'undo:reserve'], $log);
        self::assertSame(['status' => 'COMPENSATED', 'completedSteps' => []], $saga->status('saga-1'));
        self::assertSame('COMPLETED', $saga->run('saga-2', 't1', [$step('reserve'), $step('charge')]));
    }

    public function testIT6InboxDeduplicatesAndDeadLetters(): void
    {
        $connection = Messaging::connect($this->amqpUrl);
        $channel = $connection->channel();
        $this->topology->declare($channel);
        $handled = [];
        $consumer = new InboxConsumer($this->databaseUrl, $channel, $this->topology->queue, 'it-consumer', function (array $event, array $meta) use (&$handled): void {
            if (!empty($event['poison'])) {
                throw new \\RuntimeException('cannot process');
            }
            $handled[] = $meta['messageId'];
        }, $this->schema);
        foreach ([['m-1', '{"ok": true}'], ['m-1', '{"ok": true}'], ['m-poison', '{"poison": true}']] as [$id, $body]) {
            $channel->basic_publish(new AMQPMessage($body, ['message_id' => $id, 'application_headers' => new AMQPTable(['tenant_id' => 't1'])]), $this->topology->exchange, 'Test');
        }
        $consumer->drain(1.0);
        self::assertSame(['m-1'], $handled);
        self::assertSame(1, $this->countRows('ghk_inbox', 'consumer = ?', ['it-consumer']));
        self::waitFor(fn () => Messaging::messageCount($channel, $this->topology->dlq) === 1);
        self::assertSame(['m-poison'], array_map(fn (AMQPMessage $m) => $m->get('message_id'), self::drainQueue($channel, $this->topology->dlq)));
        $connection->close();
    }

    public function testIT7TraceContextPropagation(): void
    {
        $service = new CommandService($this->databaseUrl, $this->schema);
        $service->handle('t1', 'agg-1', self::COMMAND, [], null, ${php(TEST_TRACEPARENT)});
        $row = Database::rows(Database::connect($this->databaseUrl), "SELECT traceparent FROM {$this->schema}.ghk_outbox")[0];
        self::assertStringContainsString(${php(TEST_TRACE_ID)}, (string) $row['traceparent']);
        $connection = Messaging::connect($this->amqpUrl);
        $channel = $connection->channel();
        $this->topology->declare($channel);
        self::assertSame(1, (new OutboxRelay($this->databaseUrl, $channel, $this->topology->exchange, $this->schema))->publishBatch('relay', 10));
        $received = 0;
        (new InboxConsumer($this->databaseUrl, $connection->channel(), $this->topology->queue, 'trace-consumer', function () use (&$received): void {
            $received++;
        }, $this->schema))->drain(1.0);
        self::assertSame(1, $received);
        $connection->close();

        $byKind = [];
        foreach (self::$exporter->getSpans() as $span) {
            $byKind[$span->getKind()] = $span;
        }
        self::assertSame(${php(TEST_TRACE_ID)}, $byKind[SpanKind::KIND_INTERNAL]->getTraceId());
        self::assertSame(${php(TEST_PARENT_SPAN_ID)}, $byKind[SpanKind::KIND_INTERNAL]->getParentSpanId());
        self::assertSame(${php(TEST_TRACE_ID)}, $byKind[SpanKind::KIND_PRODUCER]->getTraceId());
        self::assertSame(${php(TEST_TRACE_ID)}, $byKind[SpanKind::KIND_CONSUMER]->getTraceId());
        self::assertSame($byKind[SpanKind::KIND_PRODUCER]->getSpanId(), $byKind[SpanKind::KIND_CONSUMER]->getParentSpanId());
    }
}
`;

  return [
    { filename: 'app/Runtime/Database.php', content: database },
    { filename: 'app/Runtime/Schema.php', content: schema },
    { filename: 'app/Runtime/Telemetry.php', content: telemetry },
    { filename: 'app/Runtime/CommandService.php', content: commandService },
    { filename: 'app/Runtime/Messaging.php', content: amqp },
    { filename: 'app/Runtime/OutboxRelay.php', content: relay },
    { filename: 'app/Runtime/InboxConsumer.php', content: inbox },
    { filename: 'app/Runtime/SagaOrchestrator.php', content: saga },
    { filename: 'tests/Integration/worker.php', content: worker },
    { filename: 'tests/Integration/RuntimeIntegrationTest.php', content: test }
  ];
}
