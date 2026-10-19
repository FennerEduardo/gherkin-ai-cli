/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for PHP (Laravel)
   PDO pgsql + RabbitMQ (php-amqplib) or Google Cloud Pub/Sub (REST) + OpenTelemetry PHP.
   Contract: docs/RUNTIME-KERNEL.md.
   Needs the pdo_pgsql and sockets extensions (see PHP_RUNTIME_EXTENSIONS).
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor } from './jvm';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface PhpRuntimeFile {
  filename: string;
  content: string;
}

export const PHP_RUNTIME_REQUIRE = {
  'ext-pdo_pgsql': '*',
  'ext-sockets': '*',
  'ext-curl': '*',
  'php-amqplib/php-amqplib': '^3.7',
  'open-telemetry/api': '^1.1',
  'open-telemetry/sdk': '^1.2'
};

/** Installs the PHP extensions the runtime needs in the official php / composer Alpine images. */
export const PHP_RUNTIME_EXTENSIONS = 'apk add --no-cache $PHPIZE_DEPS postgresql-dev linux-headers > /dev/null && docker-php-ext-install pdo_pgsql sockets > /dev/null';

const php = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function renderPhpRuntime(m: DomainModel, siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): PhpRuntimeFile[] {
  // Service Bus has no official PHP SDK: stack.messaging "servicebus" keeps RabbitMQ as the default broker.
  const defaultBroker = defaultBrokerFor(messaging) === 'pubsub' ? 'pubsub' : 'rabbitmq';
  const all = [m, ...siblings];
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

  const commandService = `${head}${all.map(a => `use App\\Domain\\${a.pascal}\\${a.pascal}Aggregate;
use App\\Domain\\${a.pascal}\\${a.pascal}Command;
use App\\Domain\\${a.pascal}\\${a.pascal}State;`).join('\n')}
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
    /** Aggregate type used when a request does not name one. */
    public const DEFAULT_AGGREGATE = ${php(m.pascal)};

    /** Every aggregate of the service: command name => aggregate method. */
    private const COMMANDS = [
${all.map(a => `        ${php(a.pascal)} => [
${a.commands.map(c => `            ${php(c.snake)} => ${php(c.method)},`).join('\n')}
        ],`).join('\n')}
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
    public function handle(string $tenantId, string $aggregateId, string $command, array $payload = [], ?string $idempotencyKey = null, ?string $traceparent = null, ?string $aggregateType = null): array
    {
        if ($tenantId === '') {
            throw new DomainValidationException('tenantId is required');
        }
        $aggregateType ??= self::DEFAULT_AGGREGATE;
        if (!isset(self::COMMANDS[$aggregateType])) {
            throw new DomainValidationException("Unknown aggregate type {$aggregateType}");
        }
        $parent = Telemetry::contextFrom($traceparent);
        $span = Telemetry::tracer()->spanBuilder("{$aggregateType}.{$command}")->setParent($parent)->setSpanKind(SpanKind::KIND_INTERNAL)
            ->setAttribute('tenant.id', $tenantId)->setAttribute('aggregate.id', $aggregateId)->startSpan();
        $pdo = Database::connect($this->databaseUrl);
        try {
            $pdo->beginTransaction();
            $result = $this->execute($pdo, $aggregateType, $tenantId, $aggregateId, $command, $payload, $idempotencyKey, Telemetry::traceparentOf($span, $parent));
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
    private function execute(PDO $pdo, string $aggregateType, string $tenantId, string $aggregateId, string $command, array $payload, ?string $key, ?string $traceparent): array
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
            [$tenantId, $aggregateType, $aggregateId])[0] ?? null;
        $aggregate = match ($aggregateType) {
${all.map(a => `            ${php(a.pascal)} => $row !== null
                ? ${a.pascal}Aggregate::restore($aggregateId, ${a.pascal}State::from((string) $row['state']), (int) $row['version'])
                : new ${a.pascal}Aggregate($aggregateId),`).join('\n')}
        };
        $method = self::COMMANDS[$aggregateType][$command] ?? throw new DomainValidationException("Unknown command {$command}");
        $commandObject = match ($aggregateType) {
${all.map(a => `            ${php(a.pascal)} => new ${a.pascal}Command($aggregateId, $payload),`).join('\n')}
        };
        $event = $aggregate->{$method}($commandObject);
        Database::exec($pdo, "INSERT INTO {$s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (?, ?, ?, ?, ?) "
            . 'ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()',
            [$tenantId, $aggregateType, $aggregateId, $aggregate->state()->value, $aggregate->version()]);
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
    public function load(string $tenantId, string $aggregateId, string $aggregateType = self::DEFAULT_AGGREGATE): ?array
    {
        $row = Database::rows(Database::connect($this->databaseUrl),
            "SELECT state, version FROM {$this->s}.ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ?",
            [$tenantId, $aggregateType, $aggregateId])[0] ?? null;
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

  const amqp = `${head}/**
 * Event bus destinations: publish to exchange (topic), consume from queue (subscription); dead-lettered messages
 * go to dlx and are read from dlq.
 */
final class Messaging
{
    /** The service's shared topology (same names as every other runtime and the generated IaC). */
    public const DEFAULT_PREFIX = ${php(t.exchange.replace(/\.events$/, ''))};

    public function __construct(public readonly string $exchange, public readonly string $queue, public readonly string $dlx, public readonly string $dlq)
    {
    }

    public static function forPrefix(string $prefix = self::DEFAULT_PREFIX): self
    {
        return new self("{$prefix}.events", "{$prefix}.consumer", "{$prefix}.dlx", "{$prefix}.dlq");
    }
}
`;

  const brokerMessage = `${head}/** A domain event on the wire, independent of the broker. */
final class BrokerMessage
{
    public function __construct(
        public readonly string $messageId,
        public readonly ?string $eventType,
        public readonly ?string $tenantId,
        public readonly ?string $traceparent,
        public readonly string $body,
    ) {
    }
}
`;

  const delivery = `${head}/** A received message: ack() once processed; deadLetter() moves it to the DLQ (it is not redelivered). */
final class Delivery
{
    public function __construct(public readonly BrokerMessage $message, private readonly \\Closure $onAck, private readonly \\Closure $onDeadLetter)
    {
    }

    public function ack(): void
    {
        ($this->onAck)();
    }

    public function deadLetter(): void
    {
        ($this->onDeadLetter)();
    }
}
`;

  const eventPublisher = `${head}/** Publishes to one destination; publish() returns only once the broker has durably accepted the message. */
interface EventPublisher
{
    public function system(): string;

    public function destination(): string;

    public function publish(BrokerMessage $message): void;

    public function close(): void;
}
`;

  const eventSubscription = `${head}/** Pulls messages from one queue / subscription. */
interface EventSubscription
{
    public function system(): string;

    public function source(): string;

    /** The next waiting message, or null when there is none. */
    public function poll(): ?Delivery;

    public function close(): void;
}
`;

  const brokerInterface = `${head}interface Broker
{
    public function system(): string;

    /** Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code. */
    public function declare(Messaging $topology): void;

    public function publisher(string $destination): EventPublisher;

    /** $topology says where dead-lettered messages go. */
    public function subscribe(string $source, Messaging $topology): EventSubscription;

    public function close(): void;
}
`;

  const brokers = `${head}/**
 * The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on any
 * cloud: GHK_BROKER=rabbitmq (AMQP_URL) or pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT; PUBSUB_EMULATOR_HOST).
 * Without GHK_BROKER the configured variables decide, then stack.messaging.
 * Azure Service Bus has no official PHP SDK: on Azure use self-managed RabbitMQ or CloudAMQP (AMQP_URL).
 */
final class Brokers
{
    /** Broker of the generated configuration (stack.messaging). */
    public const DEFAULT_KIND = ${php(defaultBroker)};

    public static function env(string $key): ?string
    {
        $value = getenv($key);
        return $value === false || trim($value) === '' ? null : $value;
    }

    public static function kind(): string
    {
        if (self::env('GHK_BROKER') !== null) {
            return strtolower(trim((string) self::env('GHK_BROKER')));
        }
        if (self::env('AMQP_URL') !== null) {
            return 'rabbitmq';
        }
        if (self::env('PUBSUB_PROJECT_ID') !== null || self::env('PUBSUB_EMULATOR_HOST') !== null) {
            return 'pubsub';
        }
        return self::DEFAULT_KIND;
    }

    /** Whether the variables of the selected broker are set. */
    public static function configured(): bool
    {
        return self::kind() === 'pubsub'
            ? (self::env('PUBSUB_PROJECT_ID') ?? self::env('GOOGLE_CLOUD_PROJECT')) !== null
            : self::env('AMQP_URL') !== null;
    }

    public static function connect(): Broker
    {
        return match (self::kind()) {
            'rabbitmq' => RabbitMqBroker::connect(self::env('AMQP_URL') ?? throw new \\RuntimeException('AMQP_URL is not set (amqp://user:password@host:5672)')),
            'pubsub' => PubSubBroker::fromEnv(),
            'servicebus' => throw new \\RuntimeException('Azure Service Bus has no official PHP SDK: use RabbitMQ (self-managed or CloudAMQP) on Azure'),
            default => throw new \\RuntimeException('Unsupported GHK_BROKER: ' . self::kind() . ' (rabbitmq, pubsub)'),
        };
    }
}
`;

  const rabbitBroker = `${head}use PhpAmqpLib\\Channel\\AMQPChannel;
use PhpAmqpLib\\Connection\\AbstractConnection;
use PhpAmqpLib\\Connection\\AMQPConnectionConfig;
use PhpAmqpLib\\Connection\\AMQPConnectionFactory;
use PhpAmqpLib\\Message\\AMQPMessage;
use PhpAmqpLib\\Wire\\AMQPTable;

/** RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX. */
final class RabbitMqBroker implements Broker
{
    public function __construct(private readonly AbstractConnection $connection)
    {
    }

    /** From an AMQP URL: amqp://user:password@host:5672/vhost, or amqps:// (TLS, port 5671: Amazon MQ, CloudAMQP). */
    public static function connect(string $amqpUrl): self
    {
        $url = parse_url($amqpUrl);
        $secure = ($url['scheme'] ?? 'amqp') === 'amqps';
        $config = new AMQPConnectionConfig();
        $config->setHost($url['host']);
        $config->setPort((int) ($url['port'] ?? ($secure ? 5671 : 5672)));
        $config->setUser(urldecode($url['user'] ?? 'guest'));
        $config->setPassword(urldecode($url['pass'] ?? 'guest'));
        $config->setVhost(isset($url['path']) && $url['path'] !== '/' && $url['path'] !== '' ? urldecode(substr($url['path'], 1)) : '/');
        if ($secure) {
            $config->setIsSecure(true);
            $config->setSslVerify(true);
            $config->setSslVerifyName(true);
        }
        return new self(AMQPConnectionFactory::create($config));
    }

    public function system(): string
    {
        return 'rabbitmq';
    }

    public function declare(Messaging $t): void
    {
        $channel = $this->connection->channel();
        $channel->exchange_declare($t->exchange, 'topic', false, true, false);
        $channel->exchange_declare($t->dlx, 'fanout', false, true, false);
        $channel->queue_declare($t->dlq, false, true, false, false);
        $channel->queue_bind($t->dlq, $t->dlx, '');
        $channel->queue_declare($t->queue, false, true, false, false, false, new AMQPTable(['x-dead-letter-exchange' => $t->dlx]));
        $channel->queue_bind($t->queue, $t->exchange, '#');
        $channel->close();
    }

    public function publisher(string $exchange): EventPublisher
    {
        $channel = $this->connection->channel();
        return new class ($channel, $exchange) implements EventPublisher {
            private bool $nacked = false;

            public function __construct(private readonly AMQPChannel $channel, private readonly string $exchange)
            {
                $this->channel->confirm_select();
                $this->channel->set_nack_handler(function (): void {
                    $this->nacked = true;
                });
            }

            public function system(): string
            {
                return 'rabbitmq';
            }

            public function destination(): string
            {
                return $this->exchange;
            }

            public function publish(BrokerMessage $m): void
            {
                $headers = array_filter(['tenant_id' => $m->tenantId, 'traceparent' => $m->traceparent], fn ($v) => $v !== null);
                $this->nacked = false;
                $this->channel->basic_publish(new AMQPMessage($m->body, [
                    'message_id' => $m->messageId, 'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                    'content_type' => 'application/json', 'type' => (string) $m->eventType, 'application_headers' => new AMQPTable($headers),
                ]), $this->exchange, (string) $m->eventType);
                $this->channel->wait_for_pending_acks(10);
                if ($this->nacked) {
                    throw new \\RuntimeException("Broker rejected {$m->messageId}");
                }
            }

            public function close(): void
            {
                $this->channel->close();
            }
        };
    }

    public function subscribe(string $queue, Messaging $topology): EventSubscription
    {
        $channel = $this->connection->channel();
        return new class ($channel, $queue) implements EventSubscription {
            public function __construct(private readonly AMQPChannel $channel, private readonly string $queue)
            {
            }

            public function system(): string
            {
                return 'rabbitmq';
            }

            public function source(): string
            {
                return $this->queue;
            }

            public function poll(): ?Delivery
            {
                $message = $this->channel->basic_get($this->queue);
                if ($message === null) {
                    return null;
                }
                $headers = $message->has('application_headers') ? $message->get('application_headers')->getNativeData() : [];
                $brokerMessage = new BrokerMessage(
                    $message->has('message_id') ? (string) $message->get('message_id') : '',
                    $message->has('type') ? (string) $message->get('type') : null,
                    isset($headers['tenant_id']) ? (string) $headers['tenant_id'] : null,
                    isset($headers['traceparent']) ? (string) $headers['traceparent'] : null,
                    $message->getBody(),
                );
                // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
                return new Delivery($brokerMessage, fn () => $message->ack(), fn () => $message->reject(false));
            }

            public function close(): void
            {
                $this->channel->close();
            }
        };
    }

    public function close(): void
    {
        $this->connection->close();
    }
}
`;

  const pubsubBroker = `${head}/**
 * Google Cloud Pub/Sub over its REST API (no client library, ext-curl): topics for the exchange and the DLX, pull
 * subscriptions for the queue and the DLQ. publish() returns once Pub/Sub has stored the message. A failed message is
 * dead-lettered by the consumer: published to the DLX topic, then acknowledged.
 * Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server
 * token of the workload's service account (Cloud Run, GKE workload identity).
 */
final class PubSubBroker implements Broker
{
    private const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
    private readonly string $root;
    private ?string $token = null;
    private int $tokenExpiresAt = 0;

    public function __construct(private readonly string $project, private readonly ?string $emulatorHost = null)
    {
        $this->root = ($emulatorHost !== null ? "http://{$emulatorHost}" : 'https://pubsub.googleapis.com') . "/v1/projects/{$project}";
    }

    public static function fromEnv(): self
    {
        $project = Brokers::env('PUBSUB_PROJECT_ID') ?? Brokers::env('GOOGLE_CLOUD_PROJECT')
            ?? throw new \\RuntimeException('PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
        return new self($project, Brokers::env('PUBSUB_EMULATOR_HOST'));
    }

    public function system(): string
    {
        return 'gcp_pubsub';
    }

    private function bearer(): ?string
    {
        if ($this->emulatorHost !== null) {
            return null;
        }
        if (Brokers::env('GOOGLE_OAUTH_ACCESS_TOKEN') !== null) {
            return Brokers::env('GOOGLE_OAUTH_ACCESS_TOKEN');
        }
        if ($this->token === null || time() > $this->tokenExpiresAt) {
            [$status, $response] = self::request('GET', self::METADATA_TOKEN, ['Metadata-Flavor: Google'], null, 5);
            if ($status !== 200) {
                throw new \\RuntimeException("Metadata server token request failed: {$status}");
            }
            $data = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
            $this->token = $data['access_token'];
            $this->tokenExpiresAt = time() + (int) $data['expires_in'] - 60;
        }
        return $this->token;
    }

    /**
     * One HTTP request with ext-curl (PHP's http:// stream wrapper waits for the server to close the connection).
     *
     * @param list<string> $headers
     * @return array{0: int, 1: string} status and body
     */
    private static function request(string $method, string $url, array $headers, ?string $body, int $timeout): array
    {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 5,
        ]);
        if ($body !== null) {
            curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        }
        $response = curl_exec($curl);
        if ($response === false) {
            throw new \\RuntimeException("{$method} {$url} failed: " . curl_error($curl));
        }
        return [(int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE), (string) $response];
    }

    /**
     * Calls the API; a status listed in $accepted returns null instead of failing.
     *
     * @param list<int> $accepted
     */
    public function call(string $method, string $path, array $body, array $accepted = []): ?array
    {
        $headers = ['Content-Type: application/json'];
        $token = $this->bearer();
        if ($token !== null) {
            $headers[] = "Authorization: Bearer {$token}";
        }
        [$status, $response] = self::request($method, $this->root . $path, $headers, json_encode((object) $body, JSON_THROW_ON_ERROR), 30);
        if ($status >= 200 && $status < 300) {
            return trim((string) $response) === '' ? [] : json_decode((string) $response, true, 512, JSON_THROW_ON_ERROR);
        }
        if (in_array($status, $accepted, true)) {
            return null;
        }
        throw new \\RuntimeException("Pub/Sub {$method} {$path} failed: {$status} {$response}");
    }

    public function declare(Messaging $t): void
    {
        // 409: it already exists (created earlier or by infrastructure as code).
        $this->call('PUT', "/topics/{$t->exchange}", [], [409]);
        $this->call('PUT', "/topics/{$t->dlx}", [], [409]);
        $this->call('PUT', "/subscriptions/{$t->queue}", ['topic' => "projects/{$this->project}/topics/{$t->exchange}", 'ackDeadlineSeconds' => 60], [409]);
        $this->call('PUT', "/subscriptions/{$t->dlq}", ['topic' => "projects/{$this->project}/topics/{$t->dlx}", 'ackDeadlineSeconds' => 60], [409]);
    }

    public function publishTo(string $topic, BrokerMessage $m): void
    {
        $attributes = array_filter(['ghk_message_id' => $m->messageId, 'event_type' => $m->eventType, 'tenant_id' => $m->tenantId, 'traceparent' => $m->traceparent], fn ($v) => $v !== null);
        $res = $this->call('POST', "/topics/{$topic}:publish", ['messages' => [['data' => base64_encode($m->body), 'attributes' => (object) $attributes]]]);
        if (count($res['messageIds'] ?? []) !== 1) {
            throw new \\RuntimeException("Pub/Sub did not accept message {$m->messageId}");
        }
    }

    public function publisher(string $topic): EventPublisher
    {
        return new class ($this, $topic) implements EventPublisher {
            public function __construct(private readonly PubSubBroker $broker, private readonly string $topic)
            {
            }

            public function system(): string
            {
                return 'gcp_pubsub';
            }

            public function destination(): string
            {
                return $this->topic;
            }

            public function publish(BrokerMessage $message): void
            {
                $this->broker->publishTo($this->topic, $message);
            }

            public function close(): void
            {
            }
        };
    }

    public function subscribe(string $subscription, Messaging $topology): EventSubscription
    {
        return new class ($this, $subscription, $topology) implements EventSubscription {
            public function __construct(private readonly PubSubBroker $broker, private readonly string $subscription, private readonly Messaging $topology)
            {
            }

            public function system(): string
            {
                return 'gcp_pubsub';
            }

            public function source(): string
            {
                return $this->subscription;
            }

            public function poll(): ?Delivery
            {
                $res = $this->broker->call('POST', "/subscriptions/{$this->subscription}:pull", ['maxMessages' => 1, 'returnImmediately' => true]);
                $first = $res['receivedMessages'][0] ?? null;
                if ($first === null) {
                    return null;
                }
                $msg = $first['message'];
                $attrs = $msg['attributes'] ?? [];
                $message = new BrokerMessage($attrs['ghk_message_id'] ?? $msg['messageId'], $attrs['event_type'] ?? null, $attrs['tenant_id'] ?? null,
                    $attrs['traceparent'] ?? null, base64_decode($msg['data'] ?? '', true) ?: '');
                $ack = fn () => $this->broker->call('POST', "/subscriptions/{$this->subscription}:acknowledge", ['ackIds' => [$first['ackId']]]);
                return new Delivery($message, $ack, function () use ($message, $ack): void {
                    $this->broker->publishTo($this->topology->dlx, $message);
                    $ack();
                });
            }

            public function close(): void
            {
            }
        };
    }

    public function close(): void
    {
    }
}
`;

  const relay = `${head}use OpenTelemetry\\API\\Trace\\SpanKind;
use OpenTelemetry\\API\\Trace\\StatusCode;

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
 * concurrent relays never publish the same row; the publisher returns only once the broker has
 * accepted the message, so a row is marked published only after delivery. Use one relay per process.
 */
final class OutboxRelay
{
    private readonly string $s;

    public function __construct(
        private readonly string $databaseUrl,
        private readonly EventPublisher $publisher,
        string $schema = 'public',
        private readonly int $leaseSeconds = ${LEASE_SECONDS},
        private readonly int $maxAttempts = ${MAX_PUBLISH_ATTEMPTS},
    ) {
        $this->s = Schema::name($schema);
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
            $destination = $this->publisher->destination();
            $span = Telemetry::tracer()->spanBuilder("{$destination} publish")->setParent($parent)->setSpanKind(SpanKind::KIND_PRODUCER)
                ->setAttribute('messaging.system', $this->publisher->system())->setAttribute('messaging.destination.name', $destination)
                ->setAttribute('messaging.message.id', $row['id'])->setAttribute('tenant.id', $row['tenant_id'])->startSpan();
            try {
                $this->publisher->publish(new BrokerMessage((string) $row['id'], $row['event_type'], $row['tenant_id'],
                    Telemetry::traceparentOf($span, $parent), (string) $row['payload']));
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
use PDO;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * dead-letters the message to the DLQ.
 */
final class InboxConsumer
{
    private readonly string $s;

    /** @param \\Closure(array<string, mixed>, array{messageId: string, tenantId: ?string, eventType: ?string, pdo: PDO}): void $handler */
    public function __construct(
        private readonly string $databaseUrl,
        private readonly EventSubscription $subscription,
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
            $delivery = $this->subscription->poll();
            if ($delivery === null) {
                usleep(50_000);
                continue;
            }
            $this->process($delivery);
            $processed++;
            $idleSince = microtime(true);
        }
        return $processed;
    }

    private function process(Delivery $delivery): void
    {
        $message = $delivery->message;
        $source = $this->subscription->source();
        $span = Telemetry::tracer()->spanBuilder("{$source} process")->setParent(Telemetry::contextFrom($message->traceparent))
            ->setSpanKind(SpanKind::KIND_CONSUMER)->setAttribute('messaging.system', $this->subscription->system())
            ->setAttribute('messaging.destination.name', $source)->setAttribute('messaging.message.id', $message->messageId)->startSpan();
        $pdo = Database::connect($this->databaseUrl);
        try {
            $pdo->beginTransaction();
            if (Database::exec($pdo, "INSERT INTO {$this->s}.ghk_inbox (consumer, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [$this->consumerName, $message->messageId]) === 1) {
                ($this->handler)(json_decode($message->body, true, 512, JSON_THROW_ON_ERROR), [
                    'messageId' => $message->messageId,
                    'tenantId' => $message->tenantId,
                    'eventType' => $message->eventType,
                    'pdo' => $pdo,
                ]);
            }
            $pdo->commit();
            $delivery->ack();
        } catch (\\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $span->recordException($e);
            $span->setStatus(StatusCode::STATUS_ERROR);
            $delivery->deadLetter();
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

use App\\Runtime\\Brokers;
use App\\Runtime\\CommandService;
use App\\Runtime\\OutboxRelay;

[$mode, $json] = [$argv[1], $argv[2]];
$args = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
$databaseUrl = (string) getenv('DATABASE_URL');

if ($mode === 'handle') {
    $result = (new CommandService($databaseUrl, $args['schema']))->handle($args['tenantId'], $args['aggregateId'], $args['command'], [], $args['key'] ?? null);
    echo json_encode($result);
    exit(0);
}

$broker = Brokers::connect();
$publisher = $broker->publisher($args['exchange']);
$relay = new OutboxRelay($databaseUrl, $publisher, $args['schema']);
$total = 0;
while (($n = $relay->publishBatch($args['worker'], 3)) > 0) {
    $total += $n;
}
$publisher->close();
$broker->close();
echo json_encode(['published' => $total]);
`;

  const first = m.commands[0];
  const test = `<?php

declare(strict_types=1);

namespace Tests\\Integration;

use App\\Domain\\${m.pascal}\\DomainValidationException;
use App\\Runtime\\Broker;
use App\\Runtime\\BrokerMessage;
use App\\Runtime\\Brokers;
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
use PHPUnit\\Framework\\Attributes\\Group;
use PHPUnit\\Framework\\TestCase;

/** Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and the broker variables. */
#[Group('integration')]
final class RuntimeIntegrationTest extends TestCase
{
    private const COMMAND = ${php(first.snake)};
    private const EVENT = ${php(first.event)};
    private static InMemoryExporter $exporter;
    private string $databaseUrl;
    private string $schema;
    private Messaging $topology;
    private ?Broker $broker = null;

    public static function setUpBeforeClass(): void
    {
        self::$exporter = new InMemoryExporter();
        Sdk::builder()->setTracerProvider(new TracerProvider(new SimpleSpanProcessor(self::$exporter)))->buildAndRegisterGlobal();
    }

    protected function setUp(): void
    {
        $this->databaseUrl = (string) getenv('DATABASE_URL');
        if ($this->databaseUrl === '' || !Brokers::configured()) {
            self::fail('Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).');
        }
        $uid = bin2hex(random_bytes(6));
        $this->schema = "it_{$uid}";
        $this->topology = Messaging::forPrefix("it-{$uid}");
        Schema::migrate($this->databaseUrl, $this->schema);
        self::$exporter->getStorage()->exchangeArray([]);
    }

    protected function tearDown(): void
    {
        $this->broker?->close();
        Database::connect($this->databaseUrl)->exec("DROP SCHEMA IF EXISTS {$this->schema} CASCADE");
    }

    /** The broker with this test's topology declared. */
    private function broker(): Broker
    {
        if ($this->broker === null) {
            $this->broker = Brokers::connect();
            $this->broker->declare($this->topology);
        }
        return $this->broker;
    }

    /**
     * Receives and acknowledges messages until $expected arrived and the source stays quiet for 0.5 s (10 s at most).
     *
     * @return list<BrokerMessage>
     */
    private function receive(string $source, int $expected): array
    {
        $subscription = $this->broker()->subscribe($source, $this->topology);
        $out = [];
        $deadline = microtime(true) + 10;
        $quietSince = microtime(true);
        while (microtime(true) < $deadline && (count($out) < $expected || microtime(true) - $quietSince < 0.5)) {
            $delivery = $subscription->poll();
            if ($delivery === null) {
                usleep(50_000);
                continue;
            }
            $out[] = $delivery->message;
            $delivery->ack();
            $quietSince = microtime(true);
        }
        $subscription->close();
        return $out;
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
        $this->broker();
        $outputs = $this->runWorkers('relay', [
            ['schema' => $this->schema, 'exchange' => $this->topology->exchange, 'worker' => 'relay-a'],
            ['schema' => $this->schema, 'exchange' => $this->topology->exchange, 'worker' => 'relay-b'],
        ]);
        self::assertSame(20, array_sum(array_column($outputs, 'published')));
        self::assertSame(0, $this->countRows('ghk_outbox', 'published_at IS NULL'));
        $received = $this->receive($this->topology->queue, 20);
        self::assertCount(20, $received);
        self::assertCount(20, array_unique(array_map(fn (BrokerMessage $m) => $m->messageId, $received)));
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
        $broker = $this->broker();
        $publisher = $broker->publisher($this->topology->exchange);
        foreach ([['m-1', '{"ok": true}'], ['m-1', '{"ok": true}'], ['m-poison', '{"poison": true}']] as [$id, $body]) {
            $publisher->publish(new BrokerMessage($id, 'Test', 't1', null, $body));
        }
        $publisher->close();
        $handled = [];
        $subscription = $broker->subscribe($this->topology->queue, $this->topology);
        (new InboxConsumer($this->databaseUrl, $subscription, 'it-consumer', function (array $event, array $meta) use (&$handled): void {
            if (!empty($event['poison'])) {
                throw new \\RuntimeException('cannot process');
            }
            $handled[] = $meta['messageId'];
        }, $this->schema))->drain(1.0);
        $subscription->close();
        self::assertSame(['m-1'], $handled);
        self::assertSame(1, $this->countRows('ghk_inbox', 'consumer = ?', ['it-consumer']));
        self::assertSame(['m-poison'], array_map(fn (BrokerMessage $m) => $m->messageId, $this->receive($this->topology->dlq, 1)));
    }

    public function testIT7TraceContextPropagation(): void
    {
        $service = new CommandService($this->databaseUrl, $this->schema);
        $service->handle('t1', 'agg-1', self::COMMAND, [], null, ${php(TEST_TRACEPARENT)});
        $row = Database::rows(Database::connect($this->databaseUrl), "SELECT traceparent FROM {$this->schema}.ghk_outbox")[0];
        self::assertStringContainsString(${php(TEST_TRACE_ID)}, (string) $row['traceparent']);
        $broker = $this->broker();
        $publisher = $broker->publisher($this->topology->exchange);
        self::assertSame(1, (new OutboxRelay($this->databaseUrl, $publisher, $this->schema))->publishBatch('relay', 10));
        $publisher->close();
        $received = 0;
        $subscription = $broker->subscribe($this->topology->queue, $this->topology);
        (new InboxConsumer($this->databaseUrl, $subscription, 'trace-consumer', function () use (&$received): void {
            $received++;
        }, $this->schema))->drain(1.0);
        $subscription->close();
        self::assertSame(1, $received);

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
    { filename: 'app/Runtime/BrokerMessage.php', content: brokerMessage },
    { filename: 'app/Runtime/Delivery.php', content: delivery },
    { filename: 'app/Runtime/EventPublisher.php', content: eventPublisher },
    { filename: 'app/Runtime/EventSubscription.php', content: eventSubscription },
    { filename: 'app/Runtime/Broker.php', content: brokerInterface },
    { filename: 'app/Runtime/Brokers.php', content: brokers },
    { filename: 'app/Runtime/RabbitMqBroker.php', content: rabbitBroker },
    { filename: 'app/Runtime/PubSubBroker.php', content: pubsubBroker },
    { filename: 'app/Runtime/OutboxRelay.php', content: relay },
    { filename: 'app/Runtime/InboxConsumer.php', content: inbox },
    { filename: 'app/Runtime/SagaOrchestrator.php', content: saga },
    { filename: 'tests/Integration/worker.php', content: worker },
    { filename: 'tests/Integration/RuntimeIntegrationTest.php', content: test }
  ];
}
