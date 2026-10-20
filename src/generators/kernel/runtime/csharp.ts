/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for .NET (ASP.NET Core)
   Npgsql + RabbitMQ.Client + System.Diagnostics.ActivitySource (exported by
   OpenTelemetry .NET). Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { defaultJvmBroker as defaultBrokerFor, usesKafka, usesServiceBus } from './jvm';

/** Azure SDK packages, added to the application project only for stack.messaging "servicebus". */
export const CS_SERVICEBUS_PACKAGES = [
  '<PackageReference Include="Azure.Messaging.ServiceBus" Version="7.21.0" />',
  '<PackageReference Include="Azure.Identity" Version="1.21.0" />'
];

/** Confluent's official Kafka client, added only when the Kafka adapter is generated (stack.messaging "kafka"). */
export const CS_KAFKA_PACKAGES = ['<PackageReference Include="Confluent.Kafka" Version="2.16.0" />'];
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface CsRuntimeFile {
  filename: string;
  content: string;
}

/** Packages the application project needs (RabbitMQ.Client 6.x matches MassTransit.RabbitMQ 8.1). */
export const CS_RUNTIME_PACKAGES = [
  '<PackageReference Include="Npgsql" Version="8.0.5" />',
  '<PackageReference Include="RabbitMQ.Client" Version="6.8.1" />'
];
export const CS_RUNTIME_TEST_PACKAGES = ['<PackageReference Include="OpenTelemetry.Exporter.InMemory" Version="1.19.1" />'];

const cs = (s: string) => JSON.stringify(s); // JSON strings are valid C# regular string literals here

export function renderCsRuntime(m: DomainModel, ns: string, testsDir: string, siblings: DomainModel[] = [], { messaging = undefined as string | undefined } = {}): CsRuntimeFile[] {
  const serviceBus = usesServiceBus(messaging);
  const kafka = usesKafka(messaging);
  const defaultBroker = defaultBrokerFor(messaging);
  const all = [m, ...siblings];
  const t = topology(m);
  const A = `${m.pascal}Aggregate`;
  const n = `namespace ${ns}.Runtime;\n`;
  const statements = RUNTIME_SCHEMA_SQL.map(s => `        ${cs(s)},`).join('\n');

  const connections = `using Npgsql;

${n}
/// <summary>Builds an Npgsql data source from a libpq-style URL: postgres://user:password@host:5432/database</summary>
public static class Connections
{
    public static NpgsqlDataSource FromUrl(string databaseUrl)
    {
        var uri = new Uri(databaseUrl);
        var userInfo = uri.UserInfo.Split(':', 2);
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = uri.AbsolutePath.TrimStart('/'),
            Username = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : null
        };
        return NpgsqlDataSource.Create(builder.ConnectionString);
    }
}
`;

  const schema = `using System.Text.RegularExpressions;
using Npgsql;

${n}
/// <summary>Runtime tables (docs/RUNTIME-KERNEL.md).</summary>
public static class Schema
{
    private static readonly string[] Statements =
    {
${statements}
    };

${RLS_NOTE.split('\n').map(l => `    ${l.replace(/^-- ?/, '// ')}`).join('\n')}

    public static string Name(string? schema)
    {
        var s = string.IsNullOrEmpty(schema) ? "public" : schema;
        if (!Regex.IsMatch(s, "^[a-z_][a-z0-9_]*$")) throw new ArgumentException($"Invalid schema name: {s}");
        return s;
    }

    public static async Task MigrateAsync(NpgsqlDataSource db, string? schema = null)
    {
        var s = Name(schema);
        foreach (var statement in Statements)
        {
            await using var cmd = db.CreateCommand(statement.Replace(${cs(SCHEMA_TOKEN)}, s));
            await cmd.ExecuteNonQueryAsync();
        }
    }
}
`;

  const telemetry = `using System.Diagnostics;

${n}
/// <summary>
/// Tracing through System.Diagnostics: OpenTelemetry .NET exports these activities when the source is
/// added to the tracer provider (configure exporters with the OTEL_* variables).
/// </summary>
public static class Telemetry
{
    public static readonly ActivitySource Source = new(${cs(m.kebab)});

    /// <summary>Parent context described by an incoming W3C traceparent header (default when absent or invalid).</summary>
    public static ActivityContext ParentFrom(string? traceparent) =>
        !string.IsNullOrEmpty(traceparent) && ActivityContext.TryParse(traceparent, null, out var context) ? context : default;

    /// <summary>W3C traceparent of an activity (null when nothing is listening).</summary>
    public static string? TraceparentOf(Activity? activity) =>
        activity is null ? null : $"00-{activity.TraceId.ToHexString()}-{activity.SpanId.ToHexString()}-{(activity.Recorded ? "01" : "00")}";
}
`;

  const commandService = `using System.Diagnostics;
using System.Text.Json;
using ${ns}.Domain.Kernel;
using Npgsql;

${n}
/// <summary>
/// Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
/// logic, aggregate save and outbox insert. A domain error rolls back everything.
/// </summary>
public sealed class CommandService
{
    /// <summary>Aggregate type used when a request does not name one.</summary>
    public const string DefaultAggregate = ${cs(m.pascal)};

    /// <summary>The new state of an aggregate after a command, and the recorded event.</summary>
    private sealed record Applied(string State, long Version, string EventType, long EventVersion, object Event);

    /// <summary>Every aggregate of this service: (id, state?, version, command, payload) -> applied command.</summary>
    private static readonly Dictionary<string, Func<string, string?, long, string, IReadOnlyDictionary<string, object?>?, Applied>> Aggregates = new()
    {
${all.map(a => `        [${cs(a.pascal)}] = (id, state, version, command, payload) =>
        {
            var aggregate = state is null ? new ${a.pascal}Aggregate(id) : ${a.pascal}Aggregate.Restore(id, state, version);
            var cmd = new ${a.pascal}Command(id, payload);
            ${a.pascal}DomainEvent @event = command switch
            {
${a.commands.map(c => `                ${cs(c.snake)} => aggregate.${c.name}(cmd),`).join('\n')}
                _ => throw new DomainValidationException($"Unknown command {command}")
            };
            return new Applied(aggregate.State, aggregate.Version, @event.Type, @event.Version, @event);
        },`).join('\n')}
    };

    /// <summary>AggregateType: the feature's aggregate (e.g. ${m.pascal}); null means DefaultAggregate.</summary>
    public sealed record Request(string TenantId, string AggregateId, string Command, IReadOnlyDictionary<string, object?>? Payload = null, string? IdempotencyKey = null, string? Traceparent = null, string? AggregateType = null)
    {
        public string Type => string.IsNullOrWhiteSpace(AggregateType) ? DefaultAggregate : AggregateType;
    }

    public sealed record Result(string Status, string AggregateId, string? EventType = null, long? Version = null);

    public sealed record Snapshot(string State, long Version);

    private readonly NpgsqlDataSource _db;
    private readonly string _s;

    public CommandService(NpgsqlDataSource db, string? schema = null)
    {
        _db = db;
        _s = Schema.Name(schema);
    }

    public async Task<Result> HandleAsync(Request req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(req.TenantId)) throw new DomainValidationException("TenantId is required");
        using var activity = Telemetry.Source.StartActivity($"{req.Type}.{req.Command}", ActivityKind.Internal, Telemetry.ParentFrom(req.Traceparent));
        activity?.SetTag("tenant.id", req.TenantId);
        activity?.SetTag("aggregate.id", req.AggregateId);
        await using var conn = await _db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        try
        {
            var result = await ExecuteAsync(conn, req, Telemetry.TraceparentOf(activity), ct);
            await tx.CommitAsync(ct);
            return result;
        }
        catch (Exception e)
        {
            await tx.RollbackAsync(CancellationToken.None);
            activity?.SetStatus(ActivityStatusCode.Error, e.Message);
            throw;
        }
    }

    private async Task<Result> ExecuteAsync(NpgsqlConnection conn, Request req, string? traceparent, CancellationToken ct)
    {
        if (req.IdempotencyKey is { } key)
        {
            var claimed = await Exec(conn, $"INSERT INTO {_s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING", ct, req.TenantId, key);
            if (claimed == 0)
            {
                await using var read = new NpgsqlCommand($"SELECT status, response FROM {_s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2", conn) { Parameters = { new() { Value = req.TenantId }, new() { Value = key } } };
                await using var reader = await read.ExecuteReaderAsync(ct);
                if (await reader.ReadAsync(ct) && reader.GetString(0) == "COMPLETED")
                {
                    var stored = JsonSerializer.Deserialize<Result>(reader.GetString(1))!;
                    return stored with { Status = "replayed" };
                }
                return new Result("in-progress", req.AggregateId);
            }
        }

        if (!Aggregates.TryGetValue(req.Type, out var apply)) throw new DomainValidationException($"Unknown aggregate type {req.Type}");
        string? state = null;
        long version = 0;
        await using (var load = new NpgsqlCommand($"SELECT state, version FROM {_s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE", conn)
        { Parameters = { new() { Value = req.TenantId }, new() { Value = req.Type }, new() { Value = req.AggregateId } } })
        await using (var reader = await load.ExecuteReaderAsync(ct))
        {
            if (await reader.ReadAsync(ct))
            {
                state = reader.GetString(0);
                version = reader.GetInt32(1);
            }
        }
        var applied = apply(req.AggregateId, state, version, req.Command, req.Payload);

        await Exec(conn, $"INSERT INTO {_s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) " +
            "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
            ct, req.TenantId, req.Type, req.AggregateId, applied.State, (int)applied.Version);
        await Exec(conn, $"INSERT INTO {_s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
            ct, Guid.NewGuid().ToString(), req.TenantId, req.AggregateId, applied.EventType, JsonSerializer.Serialize(applied.Event, applied.Event.GetType()), (object?)traceparent ?? DBNull.Value);
        var result = new Result("created", req.AggregateId, applied.EventType, applied.EventVersion);
        if (req.IdempotencyKey is { } completedKey)
        {
            await Exec(conn, $"UPDATE {_s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2", ct, req.TenantId, completedKey, JsonSerializer.Serialize(result));
        }
        return result;
    }

    /// <summary>The aggregate as the tenant sees it (null for other tenants' aggregates).</summary>
    public async Task<Snapshot?> LoadAsync(string tenantId, string aggregateId, string aggregateType = DefaultAggregate)
    {
        await using var cmd = _db.CreateCommand($"SELECT state, version FROM {_s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3");
        cmd.Parameters.Add(new() { Value = tenantId });
        cmd.Parameters.Add(new() { Value = aggregateType });
        cmd.Parameters.Add(new() { Value = aggregateId });
        await using var reader = await cmd.ExecuteReaderAsync();
        return await reader.ReadAsync() ? new Snapshot(reader.GetString(0), reader.GetInt32(1)) : null;
    }

    internal static async Task<int> Exec(NpgsqlConnection conn, string sql, CancellationToken ct, params object?[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        foreach (var arg in args) cmd.Parameters.Add(new NpgsqlParameter { Value = arg ?? DBNull.Value });
        return await cmd.ExecuteNonQueryAsync(ct);
    }
}
`;

  const topologyCs = `${n}
/// <summary>
/// Event bus destinations: events are published to Exchange (RabbitMQ topic exchange / Pub/Sub or Service Bus
/// topic) and consumed from Queue (queue / subscription); dead-lettered messages go to Dlx and are read from Dlq.
/// </summary>
public sealed record Topology(string Exchange, string Queue, string Dlx, string Dlq)
{
    public static readonly Topology Default = new(${cs(t.exchange)}, ${cs(t.queue)}, ${cs(t.dlx)}, ${cs(t.dlq)});

    public static Topology ForPrefix(string prefix) => new($"{prefix}.events", $"{prefix}.consumer", $"{prefix}.dlx", $"{prefix}.dlq");
}
`;

  const brokersCs = `using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using RabbitMQ.Client;

${n}
/// <summary>A domain event on the wire, independent of the broker.</summary>
public sealed record BrokerMessage(string MessageId, string? EventType, string? TenantId, string? Traceparent, byte[] Body);

/// <summary>Publishes to one destination; PublishAsync completes only once the broker has durably accepted the message.</summary>
public interface IEventPublisher : IAsyncDisposable
{
    string MessagingSystem { get; }
    string Destination { get; }
    Task PublishAsync(BrokerMessage message, CancellationToken ct = default);
}

/// <summary>A received message: Ack once processed; DeadLetter moves it to the DLQ (it is not redelivered).</summary>
public sealed record Delivery(BrokerMessage Message, Func<Task> Ack, Func<Task> DeadLetter);

/// <summary>Pulls messages from one queue / subscription.</summary>
public interface IEventSubscription : IAsyncDisposable
{
    string MessagingSystem { get; }
    string Source { get; }
    /// <summary>The next waiting message, or null when there is none.</summary>
    Task<Delivery?> PollAsync(CancellationToken ct = default);
}

public interface IBroker : IAsyncDisposable
{
    string MessagingSystem { get; }
    /// <summary>False when topics cannot be created at run time (Service Bus emulator: fixed Config.json).</summary>
    bool DynamicTopology => true;
    /// <summary>Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code.</summary>
    Task DeclareAsync(Topology topology, CancellationToken ct = default);
    Task<IEventPublisher> PublisherAsync(string destination, CancellationToken ct = default);
    /// <param name="topology">where dead-lettered messages go</param>
    Task<IEventSubscription> SubscribeAsync(string source, Topology topology, CancellationToken ct = default);
}

/// <summary>
/// The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on any
/// cloud: GHK_BROKER=rabbitmq (AMQP_URL), pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT; PUBSUB_EMULATOR_HOST)
/// servicebus (SERVICEBUS_NAMESPACE or SERVICEBUS_CONNECTION_STRING) or kafka (KAFKA_BOOTSTRAP_SERVERS), when
/// generated. Without GHK_BROKER the configured variables decide, then stack.messaging.
/// </summary>
public static class Brokers
{
    /// <summary>Broker of the generated configuration (stack.messaging).</summary>
    public const string DefaultKind = ${cs(defaultBroker)};

    private static string? Env(string key) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value : null;

    public static string Kind()
    {
        if (Env("GHK_BROKER") is { } explicitKind) return explicitKind.Trim().ToLowerInvariant();
        if (Env("AMQP_URL") is not null) return "rabbitmq";
        if (Env("PUBSUB_PROJECT_ID") is not null || Env("PUBSUB_EMULATOR_HOST") is not null) return "pubsub";
        if (Env("SERVICEBUS_CONNECTION_STRING") is not null || Env("SERVICEBUS_NAMESPACE") is not null) return "servicebus";
        if (Env("KAFKA_BOOTSTRAP_SERVERS") is not null) return "kafka";
        return DefaultKind;
    }

    /// <summary>Whether the variables of the selected broker are set.</summary>
    public static bool Configured() => Kind() switch
    {
        "pubsub" => Env("PUBSUB_PROJECT_ID") is not null || Env("GOOGLE_CLOUD_PROJECT") is not null,
        "servicebus" => Env("SERVICEBUS_CONNECTION_STRING") is not null || Env("SERVICEBUS_NAMESPACE") is not null,
        "kafka" => Env("KAFKA_BOOTSTRAP_SERVERS") is not null,
        _ => Env("AMQP_URL") is not null
    };

    public static async Task<IBroker> ConnectAsync() => Kind() switch
    {
        "rabbitmq" => (IBroker)await RabbitMqBroker.ConnectAsync(Env("AMQP_URL") ?? throw new InvalidOperationException("AMQP_URL is not set (amqp://user:password@host:5672)")),
        "pubsub" => (IBroker)PubSubBroker.FromEnv(),
        "servicebus" => ${serviceBus ? '(IBroker)ServiceBusBroker.FromEnv()' : 'throw new InvalidOperationException("The Azure Service Bus adapter is not generated: set stack.messaging to \\"servicebus\\" and regenerate")'},
        "kafka" => ${kafka ? '(IBroker)KafkaBroker.FromEnv()' : 'throw new InvalidOperationException("The Kafka adapter is not generated: set stack.messaging to \\"kafka\\" and regenerate")'},
        var kind => throw new InvalidOperationException($"Unsupported GHK_BROKER: {kind} (rabbitmq, pubsub, servicebus, kafka)")
    };
}

/// <summary>RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX.</summary>
public sealed class RabbitMqBroker(IConnection connection) : IBroker
{
    public string MessagingSystem => "rabbitmq";

    public static async Task<RabbitMqBroker> ConnectAsync(string url)
    {
        // A busy host can delay the AMQP handshake: retry before failing.
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return new RabbitMqBroker(new ConnectionFactory { Uri = new Uri(url) }.CreateConnection());
            }
            catch (Exception) when (attempt < 5)
            {
                await Task.Delay(2000 * attempt);
            }
        }
    }

    public Task DeclareAsync(Topology t, CancellationToken ct = default)
    {
        using var channel = connection.CreateModel();
        channel.ExchangeDeclare(t.Exchange, "topic", durable: true);
        channel.ExchangeDeclare(t.Dlx, "fanout", durable: true);
        channel.QueueDeclare(t.Dlq, durable: true, exclusive: false, autoDelete: false);
        channel.QueueBind(t.Dlq, t.Dlx, "");
        channel.QueueDeclare(t.Queue, durable: true, exclusive: false, autoDelete: false, arguments: new Dictionary<string, object> { ["x-dead-letter-exchange"] = t.Dlx });
        channel.QueueBind(t.Queue, t.Exchange, "#");
        return Task.CompletedTask;
    }

    public Task<IEventPublisher> PublisherAsync(string exchange, CancellationToken ct = default)
    {
        var channel = connection.CreateModel();
        channel.ConfirmSelect();
        return Task.FromResult<IEventPublisher>(new Publisher(channel, exchange));
    }

    public Task<IEventSubscription> SubscribeAsync(string queue, Topology topology, CancellationToken ct = default) =>
        Task.FromResult<IEventSubscription>(new Subscription(connection.CreateModel(), queue));

    public ValueTask DisposeAsync()
    {
        connection.Dispose();
        return ValueTask.CompletedTask;
    }

    private sealed class Publisher(IModel channel, string exchange) : IEventPublisher
    {
        public string MessagingSystem => "rabbitmq";
        public string Destination => exchange;

        public Task PublishAsync(BrokerMessage m, CancellationToken ct = default)
        {
            var props = channel.CreateBasicProperties();
            props.MessageId = m.MessageId;
            props.Persistent = true;
            props.ContentType = "application/json";
            props.Type = m.EventType;
            props.Headers = new Dictionary<string, object>();
            if (m.TenantId is not null) props.Headers["tenant_id"] = m.TenantId;
            if (m.Traceparent is not null) props.Headers["traceparent"] = m.Traceparent;
            channel.BasicPublish(exchange, m.EventType ?? "", props, m.Body);
            channel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(10));
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            channel.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Subscription(IModel channel, string queue) : IEventSubscription
    {
        public string MessagingSystem => "rabbitmq";
        public string Source => queue;

        private static string? Header(IBasicProperties props, string key) =>
            props.Headers is not null && props.Headers.TryGetValue(key, out var value)
                ? value is byte[] bytes ? Encoding.UTF8.GetString(bytes) : value?.ToString()
                : null;

        public Task<Delivery?> PollAsync(CancellationToken ct = default)
        {
            var r = channel.BasicGet(queue, autoAck: false);
            if (r is null) return Task.FromResult<Delivery?>(null);
            var props = r.BasicProperties;
            var message = new BrokerMessage(props.MessageId, props.Type, Header(props, "tenant_id"), Header(props, "traceparent"), r.Body.ToArray());
            // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
            return Task.FromResult<Delivery?>(new Delivery(message,
                () => { channel.BasicAck(r.DeliveryTag, multiple: false); return Task.CompletedTask; },
                () => { channel.BasicNack(r.DeliveryTag, multiple: false, requeue: false); return Task.CompletedTask; }));
        }

        public ValueTask DisposeAsync()
        {
            channel.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}

/// <summary>
/// Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
/// subscriptions for the queue and the DLQ. PublishAsync completes once Pub/Sub has stored the message. A failed
/// message is dead-lettered by the consumer: published to the DLX topic, then acknowledged.
/// Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the
/// metadata-server token of the workload's service account (Cloud Run, GKE workload identity).
/// </summary>
public sealed class PubSubBroker : IBroker
{
    private const string MetadataToken = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly string _project;
    private readonly string _root;
    private readonly bool _emulator;
    private string? _token;
    private DateTime _tokenExpiresAt;

    public PubSubBroker(string project, string? emulatorHost)
    {
        _project = project;
        _emulator = !string.IsNullOrWhiteSpace(emulatorHost);
        _root = (_emulator ? $"http://{emulatorHost}" : "https://pubsub.googleapis.com") + $"/v1/projects/{project}";
    }

    public static PubSubBroker FromEnv()
    {
        var project = Environment.GetEnvironmentVariable("PUBSUB_PROJECT_ID") is { Length: > 0 } p ? p : Environment.GetEnvironmentVariable("GOOGLE_CLOUD_PROJECT");
        if (string.IsNullOrWhiteSpace(project)) throw new InvalidOperationException("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set");
        return new PubSubBroker(project, Environment.GetEnvironmentVariable("PUBSUB_EMULATOR_HOST"));
    }

    public string MessagingSystem => "gcp_pubsub";

    private async Task<string?> BearerAsync(CancellationToken ct)
    {
        if (_emulator) return null;
        if (Environment.GetEnvironmentVariable("GOOGLE_OAUTH_ACCESS_TOKEN") is { Length: > 0 } fixedToken) return fixedToken;
        if (_token is null || DateTime.UtcNow > _tokenExpiresAt)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, MetadataToken);
            req.Headers.Add("Metadata-Flavor", "Google");
            using var res = await Http.SendAsync(req, ct);
            using var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            _token = body.RootElement.GetProperty("access_token").GetString();
            _tokenExpiresAt = DateTime.UtcNow.AddSeconds(body.RootElement.GetProperty("expires_in").GetInt32() - 60);
        }
        return _token;
    }

    /// <summary>Calls the API; a status listed in <paramref name="accepted"/> returns null instead of failing.</summary>
    private async Task<JsonElement?> CallAsync(HttpMethod method, string path, object? body, CancellationToken ct, params int[] accepted)
    {
        using var req = new HttpRequestMessage(method, _root + path);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        if (await BearerAsync(ct) is { } bearer) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
        using var res = await Http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (res.IsSuccessStatusCode) return string.IsNullOrWhiteSpace(text) ? null : JsonDocument.Parse(text).RootElement.Clone();
        if (accepted.Contains((int)res.StatusCode)) return null;
        throw new HttpRequestException($"Pub/Sub {method} {path} failed: {(int)res.StatusCode} {text}");
    }

    public async Task DeclareAsync(Topology t, CancellationToken ct = default)
    {
        // 409: it already exists (created earlier or by infrastructure as code).
        await CallAsync(HttpMethod.Put, $"/topics/{t.Exchange}", new { }, ct, 409);
        await CallAsync(HttpMethod.Put, $"/topics/{t.Dlx}", new { }, ct, 409);
        await CallAsync(HttpMethod.Put, $"/subscriptions/{t.Queue}", new { topic = $"projects/{_project}/topics/{t.Exchange}", ackDeadlineSeconds = 60 }, ct, 409);
        await CallAsync(HttpMethod.Put, $"/subscriptions/{t.Dlq}", new { topic = $"projects/{_project}/topics/{t.Dlx}", ackDeadlineSeconds = 60 }, ct, 409);
    }

    private async Task PublishToAsync(string topic, BrokerMessage m, CancellationToken ct)
    {
        var attributes = new Dictionary<string, string> { ["ghk_message_id"] = m.MessageId };
        if (m.EventType is not null) attributes["event_type"] = m.EventType;
        if (m.TenantId is not null) attributes["tenant_id"] = m.TenantId;
        if (m.Traceparent is not null) attributes["traceparent"] = m.Traceparent;
        var res = await CallAsync(HttpMethod.Post, $"/topics/{topic}:publish", new { messages = new[] { new { data = Convert.ToBase64String(m.Body), attributes } } }, ct);
        if (res is not { } r || !r.TryGetProperty("messageIds", out var ids) || ids.GetArrayLength() != 1)
            throw new HttpRequestException($"Pub/Sub did not accept message {m.MessageId}");
    }

    public Task<IEventPublisher> PublisherAsync(string topic, CancellationToken ct = default) => Task.FromResult<IEventPublisher>(new Publisher(this, topic));

    public Task<IEventSubscription> SubscribeAsync(string subscription, Topology topology, CancellationToken ct = default) =>
        Task.FromResult<IEventSubscription>(new Subscription(this, subscription, topology));

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private sealed class Publisher(PubSubBroker broker, string topic) : IEventPublisher
    {
        public string MessagingSystem => "gcp_pubsub";
        public string Destination => topic;
        public Task PublishAsync(BrokerMessage m, CancellationToken ct = default) => broker.PublishToAsync(topic, m, ct);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class Subscription(PubSubBroker broker, string subscription, Topology topology) : IEventSubscription
    {
        public string MessagingSystem => "gcp_pubsub";
        public string Source => subscription;

        private static string? Attr(JsonElement attrs, string key) =>
            attrs.ValueKind == JsonValueKind.Object && attrs.TryGetProperty(key, out var v) ? v.GetString() : null;

        public async Task<Delivery?> PollAsync(CancellationToken ct = default)
        {
            var res = await broker.CallAsync(HttpMethod.Post, $"/subscriptions/{subscription}:pull", new { maxMessages = 1, returnImmediately = true }, ct);
            if (res is not { } r || !r.TryGetProperty("receivedMessages", out var received) || received.GetArrayLength() == 0) return null;
            var first = received[0];
            var msg = first.GetProperty("message");
            var attrs = msg.TryGetProperty("attributes", out var a) ? a : default;
            var ackId = first.GetProperty("ackId").GetString()!;
            var data = msg.TryGetProperty("data", out var d) ? d.GetString() ?? "" : "";
            var message = new BrokerMessage(Attr(attrs, "ghk_message_id") ?? msg.GetProperty("messageId").GetString()!, Attr(attrs, "event_type"),
                Attr(attrs, "tenant_id"), Attr(attrs, "traceparent"), Convert.FromBase64String(data));
            Func<Task> ack = () => broker.CallAsync(HttpMethod.Post, $"/subscriptions/{subscription}:acknowledge", new { ackIds = new[] { ackId } }, CancellationToken.None);
            return new Delivery(message, ack, async () =>
            {
                await broker.PublishToAsync(topology.Dlx, message, CancellationToken.None);
                await ack();
            });
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
`;

  const serviceBusCs = `using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;

${n}
/// <summary>
/// Azure Service Bus (official SDK, AMQP): topics for the exchange and the DLX, subscriptions for the queue and
/// the DLQ. Auth: SERVICEBUS_CONNECTION_STRING (shared access key; the emulator) or SERVICEBUS_NAMESPACE
/// (e.g. orders.servicebus.windows.net) with Microsoft Entra ID (managed identity in Container Apps / AKS).
/// A failed message is dead-lettered by the consumer: sent to the DLX topic, then completed.
/// </summary>
public sealed class ServiceBusBroker : IBroker
{
    private readonly ServiceBusClient _client;
    private readonly string? _connectionString;
    private readonly string? _namespace;

    public ServiceBusBroker(string? connectionString, string? @namespace)
    {
        _connectionString = string.IsNullOrWhiteSpace(connectionString) ? null : connectionString;
        _namespace = @namespace;
        _client = _connectionString is not null ? new ServiceBusClient(_connectionString) : new ServiceBusClient(_namespace, new DefaultAzureCredential());
        DynamicTopology = !(_connectionString?.Contains("UseDevelopmentEmulator=true") ?? false);
    }

    public static ServiceBusBroker FromEnv()
    {
        var connectionString = Environment.GetEnvironmentVariable("SERVICEBUS_CONNECTION_STRING");
        var ns = Environment.GetEnvironmentVariable("SERVICEBUS_NAMESPACE");
        if (string.IsNullOrWhiteSpace(connectionString) && string.IsNullOrWhiteSpace(ns))
            throw new InvalidOperationException("SERVICEBUS_CONNECTION_STRING or SERVICEBUS_NAMESPACE is not set");
        return new ServiceBusBroker(connectionString, ns);
    }

    public string MessagingSystem => "servicebus";
    public bool DynamicTopology { get; }

    public async Task DeclareAsync(Topology t, CancellationToken ct = default)
    {
        // The emulator only knows the entities of its Config.json; in Azure they usually come from Terraform.
        if (!DynamicTopology) return;
        var admin = _connectionString is not null ? new ServiceBusAdministrationClient(_connectionString) : new ServiceBusAdministrationClient(_namespace, new DefaultAzureCredential());
        foreach (var topic in new[] { t.Exchange, t.Dlx })
            if (!(await admin.TopicExistsAsync(topic, ct)).Value) await admin.CreateTopicAsync(topic, ct);
        if (!(await admin.SubscriptionExistsAsync(t.Exchange, t.Queue, ct)).Value) await admin.CreateSubscriptionAsync(t.Exchange, t.Queue, ct);
        if (!(await admin.SubscriptionExistsAsync(t.Dlx, t.Dlq, ct)).Value) await admin.CreateSubscriptionAsync(t.Dlx, t.Dlq, ct);
    }

    private static ServiceBusMessage ToMessage(BrokerMessage m)
    {
        var message = new ServiceBusMessage(m.Body) { MessageId = m.MessageId, ContentType = "application/json", Subject = m.EventType };
        if (m.TenantId is not null) message.ApplicationProperties["tenant_id"] = m.TenantId;
        if (m.Traceparent is not null) message.ApplicationProperties["ghk_traceparent"] = m.Traceparent;
        return message;
    }

    public Task<IEventPublisher> PublisherAsync(string topic, CancellationToken ct = default) =>
        Task.FromResult<IEventPublisher>(new Publisher(_client.CreateSender(topic), topic));

    public Task<IEventSubscription> SubscribeAsync(string subscription, Topology topology, CancellationToken ct = default)
    {
        var topic = subscription == topology.Dlq ? topology.Dlx : topology.Exchange;
        var receiver = _client.CreateReceiver(topic, subscription, new ServiceBusReceiverOptions { ReceiveMode = ServiceBusReceiveMode.PeekLock });
        return Task.FromResult<IEventSubscription>(new Subscription(_client, receiver, subscription, topology));
    }

    public ValueTask DisposeAsync() => _client.DisposeAsync();

    private sealed class Publisher(ServiceBusSender sender, string topic) : IEventPublisher
    {
        public string MessagingSystem => "servicebus";
        public string Destination => topic;
        public Task PublishAsync(BrokerMessage m, CancellationToken ct = default) => sender.SendMessageAsync(ToMessage(m), ct);
        public ValueTask DisposeAsync() => sender.DisposeAsync();
    }

    private sealed class Subscription(ServiceBusClient client, ServiceBusReceiver receiver, string subscription, Topology topology) : IEventSubscription
    {
        private ServiceBusSender? _deadLetters;
        public string MessagingSystem => "servicebus";
        public string Source => subscription;

        public async Task<Delivery?> PollAsync(CancellationToken ct = default)
        {
            var msg = await receiver.ReceiveMessageAsync(TimeSpan.FromMilliseconds(500), ct);
            if (msg is null) return null;
            string? Prop(string key) => msg.ApplicationProperties.TryGetValue(key, out var v) ? v?.ToString() : null;
            var message = new BrokerMessage(msg.MessageId, msg.Subject, Prop("tenant_id"), Prop("ghk_traceparent"), msg.Body.ToArray());
            return new Delivery(message, () => receiver.CompleteMessageAsync(msg), async () =>
            {
                _deadLetters ??= client.CreateSender(topology.Dlx);
                await _deadLetters.SendMessageAsync(ToMessage(message));
                await receiver.CompleteMessageAsync(msg);
            });
        }

        public async ValueTask DisposeAsync()
        {
            if (_deadLetters is not null) await _deadLetters.DisposeAsync();
            await receiver.DisposeAsync();
        }
    }
}
`;

  const kafkaCs = `using System.Text;
using Confluent.Kafka;
using Confluent.Kafka.Admin;

${n}
/// <summary>
/// Apache Kafka (Confluent's official client, librdkafka): topics for the exchange and the DLX; the queue and the
/// DLQ are consumer groups on them. KAFKA_BOOTSTRAP_SERVERS, and for managed clusters (Confluent Cloud, Event Hubs,
/// MSK with SASL/SCRAM) KAFKA_SECURITY_PROTOCOL, KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD.
/// PublishAsync completes once every in-sync replica has the message (acks=all, idempotent producer). Ack commits
/// the offset; a message that is neither acked nor dead-lettered is read again by the next poll.
/// </summary>
public sealed class KafkaBroker(ClientConfig config) : IBroker
{
    private static string? Env(string key) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value : null;

    // ProducerConfig(config) and ConsumerConfig(config) wrap the same dictionary: each client gets its own copy.
    private Dictionary<string, string> Settings() => config.ToDictionary(kv => kv.Key, kv => kv.Value);

    public static KafkaBroker FromEnv()
    {
        var config = new ClientConfig { BootstrapServers = Env("KAFKA_BOOTSTRAP_SERVERS") ?? throw new InvalidOperationException("KAFKA_BOOTSTRAP_SERVERS is not set (host:9092)") };
        if (Env("KAFKA_SECURITY_PROTOCOL") is { } protocol) config.SecurityProtocol = Enum.Parse<SecurityProtocol>(protocol.Replace("_", ""), ignoreCase: true);
        if (Env("KAFKA_SASL_USERNAME") is { } user)
        {
            config.SaslMechanism = Enum.Parse<SaslMechanism>((Env("KAFKA_SASL_MECHANISM") ?? "PLAIN").Replace("-", ""), ignoreCase: true);
            config.SaslUsername = user;
            config.SaslPassword = Env("KAFKA_SASL_PASSWORD");
        }
        return new KafkaBroker(config);
    }

    public string MessagingSystem => "kafka";

    public async Task DeclareAsync(Topology t, CancellationToken ct = default)
    {
        using var admin = new AdminClientBuilder(new AdminClientConfig(Settings())).Build();
        foreach (var topic in new[] { t.Exchange, t.Dlx })
        {
            try
            {
                await admin.CreateTopicsAsync([new TopicSpecification { Name = topic, NumPartitions = -1, ReplicationFactor = -1 }]);
            }
            catch (CreateTopicsException e) when (e.Results.All(r => r.Error.Code == ErrorCode.TopicAlreadyExists))
            {
            }
        }
    }

    private static Message<string?, byte[]> ToMessage(BrokerMessage m)
    {
        var headers = new Headers { { "message_id", Encoding.UTF8.GetBytes(m.MessageId) } };
        if (m.EventType is not null) headers.Add("event_type", Encoding.UTF8.GetBytes(m.EventType));
        if (m.TenantId is not null) headers.Add("tenant_id", Encoding.UTF8.GetBytes(m.TenantId));
        if (m.Traceparent is not null) headers.Add("traceparent", Encoding.UTF8.GetBytes(m.Traceparent));
        return new Message<string?, byte[]> { Key = m.TenantId, Value = m.Body, Headers = headers };
    }

    private IProducer<string?, byte[]> Producer() =>
        new ProducerBuilder<string?, byte[]>(new ProducerConfig(Settings()) { Acks = Acks.All, EnableIdempotence = true, MessageTimeoutMs = 30000 }).Build();

    public Task<IEventPublisher> PublisherAsync(string topic, CancellationToken ct = default) =>
        Task.FromResult<IEventPublisher>(new Publisher(Producer(), topic));

    public Task<IEventSubscription> SubscribeAsync(string group, Topology topology, CancellationToken ct = default)
    {
        var topic = group == topology.Dlq ? topology.Dlx : topology.Exchange;
        var consumer = new ConsumerBuilder<string?, byte[]>(new ConsumerConfig(Settings())
        {
            GroupId = group,
            EnableAutoCommit = false,
            AutoOffsetReset = AutoOffsetReset.Earliest
        }).Build();
        consumer.Subscribe(topic);
        return Task.FromResult<IEventSubscription>(new Subscription(this, consumer, group, topology));
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private sealed class Publisher(IProducer<string?, byte[]> producer, string topic) : IEventPublisher
    {
        public string MessagingSystem => "kafka";
        public string Destination => topic;
        public Task PublishAsync(BrokerMessage m, CancellationToken ct = default) => producer.ProduceAsync(topic, ToMessage(m), ct);

        public ValueTask DisposeAsync()
        {
            producer.Flush(TimeSpan.FromSeconds(5));
            producer.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Subscription(KafkaBroker broker, IConsumer<string?, byte[]> consumer, string group, Topology topology) : IEventSubscription
    {
        private ConsumeResult<string?, byte[]>? _pending;
        private IProducer<string?, byte[]>? _deadLetters;
        public string MessagingSystem => "kafka";
        public string Source => group;

        private void Commit(ConsumeResult<string?, byte[]> r)
        {
            consumer.Commit([new TopicPartitionOffset(r.TopicPartition, r.Offset + 1)]);
            _pending = null;
        }

        public Task<Delivery?> PollAsync(CancellationToken ct = default)
        {
            // Neither acked nor dead-lettered: read it again, as RabbitMQ redelivers an unacknowledged message.
            if (_pending is not null) consumer.Seek(_pending.TopicPartitionOffset);
            var r = consumer.Consume(TimeSpan.FromMilliseconds(200));
            // A new member gets its partitions only after the group rebalance: wait for it (30 s at most) so the
            // first poll does not report an empty source that merely has not been assigned yet.
            for (var joined = DateTime.UtcNow; r is null && consumer.Assignment.Count == 0 && DateTime.UtcNow - joined < TimeSpan.FromSeconds(30);)
                r = consumer.Consume(TimeSpan.FromMilliseconds(200));
            if (r is null || r.IsPartitionEOF) return Task.FromResult<Delivery?>(null);
            _pending = r;
            string? Header(string name) => r.Message.Headers.TryGetLastBytes(name, out var bytes) ? Encoding.UTF8.GetString(bytes) : null;
            var message = new BrokerMessage(Header("message_id") ?? $"{r.TopicPartitionOffset}", Header("event_type"), Header("tenant_id"), Header("traceparent"), r.Message.Value);
            return Task.FromResult<Delivery?>(new Delivery(message, () =>
            {
                Commit(r);
                return Task.CompletedTask;
            }, async () =>
            {
                _deadLetters ??= broker.Producer();
                await _deadLetters.ProduceAsync(topology.Dlx, ToMessage(message));
                Commit(r);
            }));
        }

        public ValueTask DisposeAsync()
        {
            _deadLetters?.Dispose();
            consumer.Close();
            consumer.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
`;

  const relay = `using System.Diagnostics;
using System.Text;
using Npgsql;

${n}
/// <summary>
/// Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
/// concurrent relays never publish the same row; the publisher completes only once the broker has
/// accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before a row is marked
/// published. Use one relay (and publisher) per worker.
/// </summary>
public sealed class OutboxRelay
{
    private readonly NpgsqlDataSource _db;
    private readonly IEventPublisher _publisher;
    private readonly string _s;
    public int LeaseSeconds { get; init; } = ${LEASE_SECONDS};
    public int MaxAttempts { get; init; } = ${MAX_PUBLISH_ATTEMPTS};

    public OutboxRelay(NpgsqlDataSource db, IEventPublisher publisher, string? schema = null)
    {
        _db = db;
        _publisher = publisher;
        _s = Schema.Name(schema);
    }

    private sealed record Claimed(string Id, string TenantId, string EventType, string Payload, string? Traceparent);

    public async Task<int> PublishBatchAsync(string workerId, int limit = 50, CancellationToken ct = default)
    {
        var batch = new List<Claimed>();
        await using var conn = await _db.OpenConnectionAsync(ct);
        await using (var claim = new NpgsqlCommand(
            $"UPDATE {_s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1 " +
            $"WHERE id IN (SELECT id FROM {_s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) " +
            "ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent", conn)
        { Parameters = { new() { Value = workerId }, new() { Value = (double)LeaseSeconds }, new() { Value = limit } } })
        await using (var reader = await claim.ExecuteReaderAsync(ct))
        {
            while (await reader.ReadAsync(ct))
                batch.Add(new Claimed(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4)));
        }

        var published = 0;
        foreach (var row in batch)
        {
            using var activity = Telemetry.Source.StartActivity($"{_publisher.Destination} publish", ActivityKind.Producer, Telemetry.ParentFrom(row.Traceparent));
            activity?.SetTag("messaging.system", _publisher.MessagingSystem);
            activity?.SetTag("messaging.destination.name", _publisher.Destination);
            activity?.SetTag("messaging.message.id", row.Id);
            activity?.SetTag("tenant.id", row.TenantId);
            try
            {
                await _publisher.PublishAsync(new BrokerMessage(row.Id, row.EventType, row.TenantId, Telemetry.TraceparentOf(activity), Encoding.UTF8.GetBytes(row.Payload)), ct);
                await CommandService.Exec(conn, $"UPDATE {_s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2", ct, row.Id, workerId);
                published++;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Message);
                await CommandService.Exec(conn, $"UPDATE {_s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1",
                    ct, row.Id, e.Message, MaxAttempts);
            }
        }
        return published;
    }
}
`;

  const inbox = `using System.Diagnostics;
using System.Text.Json;
using Npgsql;

${n}
/// <summary>
/// Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
/// handler, so redeliveries are acknowledged without running the handler twice. A handler error
/// dead-letters the message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered.
/// </summary>
public sealed class InboxConsumer
{
    public sealed record Meta(string MessageId, string? TenantId, string? EventType, NpgsqlConnection Connection);

    private readonly NpgsqlDataSource _db;
    private readonly IEventSubscription _subscription;
    private readonly string _name;
    private readonly Func<JsonElement, Meta, Task> _handler;
    private readonly string _s;

    public InboxConsumer(NpgsqlDataSource db, IEventSubscription subscription, string consumerName, Func<JsonElement, Meta, Task> handler, string? schema = null)
    {
        _db = db;
        _subscription = subscription;
        _name = consumerName;
        _handler = handler;
        _s = Schema.Name(schema);
    }

    /// <summary>Processes messages until the source stays empty for <paramref name="idle"/>; returns how many were processed.</summary>
    public async Task<int> DrainAsync(TimeSpan idle, CancellationToken ct = default)
    {
        var processed = 0;
        var idleSince = DateTime.UtcNow;
        while (DateTime.UtcNow - idleSince < idle)
        {
            var delivery = await _subscription.PollAsync(ct);
            if (delivery is null)
            {
                await Task.Delay(50, ct);
                continue;
            }
            await ProcessAsync(delivery);
            processed++;
            idleSince = DateTime.UtcNow;
        }
        return processed;
    }

    private async Task ProcessAsync(Delivery delivery)
    {
        var message = delivery.Message;
        using var activity = Telemetry.Source.StartActivity($"{_subscription.Source} process", ActivityKind.Consumer, Telemetry.ParentFrom(message.Traceparent));
        activity?.SetTag("messaging.system", _subscription.MessagingSystem);
        activity?.SetTag("messaging.destination.name", _subscription.Source);
        activity?.SetTag("messaging.message.id", message.MessageId);
        try
        {
            await using var conn = await _db.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            if (await CommandService.Exec(conn, $"INSERT INTO {_s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", CancellationToken.None, _name, message.MessageId) == 1)
            {
                using var json = JsonDocument.Parse(message.Body);
                await _handler(json.RootElement.Clone(), new Meta(message.MessageId, message.TenantId, message.EventType, conn));
            }
            await tx.CommitAsync();
            await delivery.Ack();
        }
        catch (Exception e)
        {
            activity?.SetStatus(ActivityStatusCode.Error, e.Message);
            await delivery.DeadLetter();
        }
    }
}
`;

  const saga = `using Npgsql;

${n}
/// <summary>
/// Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
/// are compensated in reverse order. Re-running a saga id resumes after its completed steps.
/// </summary>
public sealed class SagaOrchestrator
{
    public sealed record Step(string Name, Func<Task> Action, Func<Task> Compensate);

    public sealed record Status(string Value, IReadOnlyList<string> CompletedSteps);

    private readonly NpgsqlDataSource _db;
    private readonly string _s;

    public SagaOrchestrator(NpgsqlDataSource db, string? schema = null)
    {
        _db = db;
        _s = Schema.Name(schema);
    }

    public async Task<string> RunAsync(string sagaId, string tenantId, IReadOnlyList<Step> steps)
    {
        await using var conn = await _db.OpenConnectionAsync();
        await CommandService.Exec(conn, $"INSERT INTO {_s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING", CancellationToken.None, sagaId, tenantId);
        var completed = new List<string>((await StatusAsync(sagaId))?.CompletedSteps ?? Array.Empty<string>());
        foreach (var step in steps)
        {
            if (completed.Contains(step.Name)) continue;
            try
            {
                await step.Action();
            }
            catch
            {
                await Save(conn, sagaId, "COMPENSATING", completed);
                for (var i = completed.Count - 1; i >= 0; i--)
                {
                    await steps.First(s => s.Name == completed[i]).Compensate();
                    completed.RemoveAt(i);
                    await Save(conn, sagaId, "COMPENSATING", completed);
                }
                await Save(conn, sagaId, "COMPENSATED", completed);
                return "COMPENSATED";
            }
            completed.Add(step.Name);
            await Save(conn, sagaId, "RUNNING", completed);
        }
        await Save(conn, sagaId, "COMPLETED", completed);
        return "COMPLETED";
    }

    public async Task<Status?> StatusAsync(string sagaId)
    {
        await using var cmd = _db.CreateCommand($"SELECT status, completed_steps FROM {_s}.ghk_sagas WHERE id = $1");
        cmd.Parameters.Add(new() { Value = sagaId });
        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;
        var done = reader.GetString(1);
        return new Status(reader.GetString(0), done.Length == 0 ? Array.Empty<string>() : done.Split(','));
    }

    private Task Save(NpgsqlConnection conn, string sagaId, string status, List<string> completed) =>
        CommandService.Exec(conn, $"UPDATE {_s}.ghk_sagas SET status = $2, completed_steps = $3, updated_at = now() WHERE id = $1", CancellationToken.None, sagaId, status, string.Join(',', completed));
}
`;

  const first = m.commands[0];
  const test = `using System.Diagnostics;
using System.Text;
using ${ns}.Domain.Kernel;
using ${ns}.Runtime;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Trace;
using Xunit;

namespace ${ns}.Tests.Runtime;

/// <summary>
/// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and the selected broker
/// (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST], servicebus).
/// </summary>
[Trait("Category", "Integration")]
[Collection("runtime")]
public sealed class RuntimeIntegrationTests : IAsyncLifetime
{
    private const string Command = ${cs(first.snake)};
    private const string Event = ${cs(first.event)};
    private readonly NpgsqlDataSource _db;
    private readonly string _schema;
    private readonly string _uid;
    private IBroker _broker = null!;
    private Topology _topology = null!;

    public RuntimeIntegrationTests()
    {
        var dbUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
        if (string.IsNullOrEmpty(dbUrl) || !Brokers.Configured())
            throw new InvalidOperationException("Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).");
        _db = Connections.FromUrl(dbUrl);
        _uid = Guid.NewGuid().ToString("N")[..12];
        _schema = $"it_{_uid}";
    }

    public async Task InitializeAsync()
    {
        await Schema.MigrateAsync(_db, _schema);
        _broker = await Brokers.ConnectAsync();
        // Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
        _topology = _broker.DynamicTopology ? Topology.ForPrefix($"it-{_uid}") : Topology.ForPrefix("it");
        await _broker.DeclareAsync(_topology);
        if (!_broker.DynamicTopology)
        {
            await Receive(_topology.Queue, 0);
            await Receive(_topology.Dlq, 0);
        }
    }

    public async Task DisposeAsync()
    {
        await using (var cmd = _db.CreateCommand($"DROP SCHEMA IF EXISTS {_schema} CASCADE")) await cmd.ExecuteNonQueryAsync();
        await _broker.DisposeAsync();
        await _db.DisposeAsync();
    }

    /// <summary>Receives and acknowledges messages until the expected number arrived and the source stays quiet for 500 ms (10 s at most).</summary>
    private async Task<List<BrokerMessage>> Receive(string source, int expected)
    {
        var received = new List<BrokerMessage>();
        await using var subscription = await _broker.SubscribeAsync(source, _topology);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        var quietSince = DateTime.UtcNow;
        while (DateTime.UtcNow < deadline && (received.Count < expected || DateTime.UtcNow - quietSince < TimeSpan.FromMilliseconds(500)))
        {
            var delivery = await subscription.PollAsync();
            if (delivery is null)
            {
                await Task.Delay(50);
                continue;
            }
            received.Add(delivery.Message);
            await delivery.Ack();
            quietSince = DateTime.UtcNow;
        }
        return received;
    }

    private async Task<long> Count(string table, string where = "true", params object[] args)
    {
        await using var cmd = _db.CreateCommand($"SELECT count(*) FROM {_schema}.{table} WHERE {where}");
        foreach (var a in args) cmd.Parameters.Add(new NpgsqlParameter { Value = a });
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    [Fact]
    public async Task IT1_AtomicWriteAndRollback()
    {
        var service = new CommandService(_db, _schema);
        var result = await service.HandleAsync(new("t1", "agg-1", Command));
        Assert.Equal(("created", Event, 1L), (result.Status, result.EventType, result.Version!.Value));
        Assert.Equal(1, (await service.LoadAsync("t1", "agg-1"))!.Version);
        Assert.Equal(1, await Count("ghk_outbox", "aggregate_id = $1", "agg-1"));

        var failure = await Assert.ThrowsAsync<DomainValidationException>(() => service.HandleAsync(new("t1", "agg-2", "no_such_command", IdempotencyKey: "k-fail")));
        Assert.Contains("Unknown command", failure.Message);
        Assert.Null(await service.LoadAsync("t1", "agg-2"));
        Assert.Equal(0, await Count("ghk_outbox", "aggregate_id = $1", "agg-2"));
        Assert.Equal(0, await Count("ghk_idempotency", "key = $1", "k-fail"));
    }

    [Fact]
    public async Task IT2_ConcurrentIdempotentRequests()
    {
        var service = new CommandService(_db, _schema);
        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Task.Run(() => service.HandleAsync(new("t1", "agg-1", Command, IdempotencyKey: "key-1")))));
        Assert.Equal(1, await Count("ghk_outbox"));
        Assert.Equal(1, (await service.LoadAsync("t1", "agg-1"))!.Version);
        Assert.Single(results, r => r.Status == "created");
        Assert.All(results, r => Assert.Equal((Event, 1L), (r.EventType, r.Version!.Value)));
    }

    [Fact]
    public async Task IT3_ConcurrentRelaysPublishExactlyOnce()
    {
        var service = new CommandService(_db, _schema);
        for (var i = 0; i < 20; i++) await service.HandleAsync(new("t1", $"agg-{i}", Command));
        async Task<int> Drain(string worker)
        {
            await using var publisher = await _broker.PublisherAsync(_topology.Exchange);
            var relay = new OutboxRelay(_db, publisher, _schema);
            var total = 0;
            for (var n = await relay.PublishBatchAsync(worker, 3); n > 0; n = await relay.PublishBatchAsync(worker, 3)) total += n;
            return total;
        }
        var totals = await Task.WhenAll(Task.Run(() => Drain("relay-a")), Task.Run(() => Drain("relay-b")));
        Assert.Equal(20, totals.Sum());
        Assert.Equal(0, await Count("ghk_outbox", "published_at IS NULL"));
        var received = await Receive(_topology.Queue, 20);
        Assert.Equal(20, received.Count);
        Assert.Equal(20, received.Select(m => m.MessageId).Distinct().Count());
    }

    [Fact]
    public async Task IT4_TenantIsolation()
    {
        var service = new CommandService(_db, _schema);
        await service.HandleAsync(new("tenant-a", "shared-id", Command));
        Assert.Null(await service.LoadAsync("tenant-b", "shared-id"));
        await service.HandleAsync(new("tenant-b", "shared-id", Command));
        Assert.Equal(1, (await service.LoadAsync("tenant-a", "shared-id"))!.Version);
        Assert.Equal(1, (await service.LoadAsync("tenant-b", "shared-id"))!.Version);
        Assert.Equal(1, await Count("ghk_outbox", "tenant_id = $1", "tenant-a"));
    }

    [Fact]
    public async Task IT5_SagaCompensatesInReverseOrder()
    {
        var saga = new SagaOrchestrator(_db, _schema);
        var log = new List<string>();
        SagaOrchestrator.Step Step(string name, bool fail = false) => new(name,
            () => { if (fail) throw new InvalidOperationException($"{name} failed"); log.Add($"do:{name}"); return Task.CompletedTask; },
            () => { log.Add($"undo:{name}"); return Task.CompletedTask; });
        Assert.Equal("COMPENSATED", await saga.RunAsync("saga-1", "t1", new[] { Step("reserve"), Step("charge"), Step("ship", fail: true) }));
        Assert.Equal(new[] { "do:reserve", "do:charge", "undo:charge", "undo:reserve" }, log);
        var status = await saga.StatusAsync("saga-1");
        Assert.Equal("COMPENSATED", status!.Value);
        Assert.Empty(status.CompletedSteps);
        Assert.Equal("COMPLETED", await saga.RunAsync("saga-2", "t1", new[] { Step("reserve"), Step("charge") }));
    }

    [Fact]
    public async Task IT6_InboxDeduplicatesAndDeadLetters()
    {
        var handled = new List<string>();
        await using (var publisher = await _broker.PublisherAsync(_topology.Exchange))
        await using (var subscription = await _broker.SubscribeAsync(_topology.Queue, _topology))
        {
            var consumer = new InboxConsumer(_db, subscription, "it-consumer", (json, meta) =>
            {
                if (json.TryGetProperty("poison", out _)) throw new InvalidOperationException("cannot process");
                handled.Add(meta.MessageId);
                return Task.CompletedTask;
            }, _schema);
            foreach (var (id, body) in new[] { ("m-1", "{\\"ok\\": true}"), ("m-1", "{\\"ok\\": true}"), ("m-poison", "{\\"poison\\": true}") })
                await publisher.PublishAsync(new BrokerMessage(id, "Test", "t1", null, Encoding.UTF8.GetBytes(body)));
            await consumer.DrainAsync(TimeSpan.FromSeconds(1));
        }
        Assert.Equal(new[] { "m-1" }, handled);
        Assert.Equal(1, await Count("ghk_inbox", "consumer = $1", "it-consumer"));
        Assert.Equal(new[] { "m-poison" }, (await Receive(_topology.Dlq, 1)).Select(m => m.MessageId));
    }

    [Fact]
    public async Task IT7_TraceContextPropagation()
    {
        var exported = new List<Activity>();
        using var provider = Sdk.CreateTracerProviderBuilder().AddSource(Telemetry.Source.Name).AddInMemoryExporter(exported).Build();
        var service = new CommandService(_db, _schema);
        await service.HandleAsync(new("t1", "agg-1", Command, Traceparent: ${cs(TEST_TRACEPARENT)}));
        await using (var cmd = _db.CreateCommand($"SELECT traceparent FROM {_schema}.ghk_outbox"))
            Assert.Contains(${cs(TEST_TRACE_ID)}, (string)(await cmd.ExecuteScalarAsync())!);
        await using (var publisher = await _broker.PublisherAsync(_topology.Exchange))
            Assert.Equal(1, await new OutboxRelay(_db, publisher, _schema).PublishBatchAsync("relay", 10));
        var received = 0;
        await using (var subscription = await _broker.SubscribeAsync(_topology.Queue, _topology))
            await new InboxConsumer(_db, subscription, "trace-consumer", (_, _) => { received++; return Task.CompletedTask; }, _schema).DrainAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(1, received);
        provider!.ForceFlush();

        var command = exported.Single(a => a.Kind == ActivityKind.Internal);
        var producer = exported.Single(a => a.Kind == ActivityKind.Producer);
        var consumer = exported.Single(a => a.Kind == ActivityKind.Consumer);
        Assert.Equal(${cs(TEST_TRACE_ID)}, command.TraceId.ToHexString());
        Assert.Equal(${cs(TEST_PARENT_SPAN_ID)}, command.ParentSpanId.ToHexString());
        Assert.Equal(${cs(TEST_TRACE_ID)}, producer.TraceId.ToHexString());
        Assert.Equal(${cs(TEST_TRACE_ID)}, consumer.TraceId.ToHexString());
        Assert.Equal(producer.SpanId, consumer.ParentSpanId);
    }
}
`;

  return [
    { filename: 'src/Runtime/Connections.cs', content: connections },
    { filename: 'src/Runtime/Schema.cs', content: schema },
    { filename: 'src/Runtime/Telemetry.cs', content: telemetry },
    { filename: 'src/Runtime/CommandService.cs', content: commandService },
    { filename: 'src/Runtime/Topology.cs', content: topologyCs },
    { filename: 'src/Runtime/Brokers.cs', content: brokersCs },
    ...(serviceBus ? [{ filename: 'src/Runtime/ServiceBusBroker.cs', content: serviceBusCs }] : []),
    ...(kafka ? [{ filename: 'src/Runtime/KafkaBroker.cs', content: kafkaCs }] : []),
    { filename: 'src/Runtime/OutboxRelay.cs', content: relay },
    { filename: 'src/Runtime/InboxConsumer.cs', content: inbox },
    { filename: 'src/Runtime/SagaOrchestrator.cs', content: saga },
    { filename: `${testsDir}/Runtime/RuntimeIntegrationTests.cs`, content: test }
  ];
}
