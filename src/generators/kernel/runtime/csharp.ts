/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for .NET (ASP.NET Core)
   Npgsql + RabbitMQ.Client + System.Diagnostics.ActivitySource (exported by
   OpenTelemetry .NET). Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
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
export const CS_RUNTIME_TEST_PACKAGES = ['<PackageReference Include="OpenTelemetry.Exporter.InMemory" Version="1.9.0" />'];

const cs = (s: string) => JSON.stringify(s); // JSON strings are valid C# regular string literals here

export function renderCsRuntime(m: DomainModel, ns: string, testsDir: string): CsRuntimeFile[] {
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
    private const string AggregateType = ${cs(m.pascal)};

    private static readonly Dictionary<string, Func<${A}, ${m.pascal}Command, ${m.pascal}DomainEvent>> Commands = new()
    {
${m.commands.map(c => `        [${cs(c.snake)}] = (a, c) => a.${c.name}(c),`).join('\n')}
    };

    public sealed record Request(string TenantId, string AggregateId, string Command, IReadOnlyDictionary<string, object?>? Payload = null, string? IdempotencyKey = null, string? Traceparent = null);

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
        using var activity = Telemetry.Source.StartActivity($"{AggregateType}.{req.Command}", ActivityKind.Internal, Telemetry.ParentFrom(req.Traceparent));
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

        ${A} aggregate;
        await using (var load = new NpgsqlCommand($"SELECT state, version FROM {_s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE", conn)
        { Parameters = { new() { Value = req.TenantId }, new() { Value = AggregateType }, new() { Value = req.AggregateId } } })
        await using (var reader = await load.ExecuteReaderAsync(ct))
        {
            aggregate = await reader.ReadAsync(ct)
                ? ${A}.Restore(req.AggregateId, reader.GetString(0), reader.GetInt32(1))
                : new ${A}(req.AggregateId);
        }
        if (!Commands.TryGetValue(req.Command, out var handler)) throw new DomainValidationException($"Unknown command {req.Command}");
        var @event = handler(aggregate, new ${m.pascal}Command(req.AggregateId, req.Payload));

        await Exec(conn, $"INSERT INTO {_s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5) " +
            "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
            ct, req.TenantId, AggregateType, req.AggregateId, aggregate.State, (int)aggregate.Version);
        await Exec(conn, $"INSERT INTO {_s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)",
            ct, Guid.NewGuid().ToString(), req.TenantId, req.AggregateId, @event.Type, JsonSerializer.Serialize(@event), (object?)traceparent ?? DBNull.Value);
        var result = new Result("created", req.AggregateId, @event.Type, @event.Version);
        if (req.IdempotencyKey is { } completedKey)
        {
            await Exec(conn, $"UPDATE {_s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2", ct, req.TenantId, completedKey, JsonSerializer.Serialize(result));
        }
        return result;
    }

    /// <summary>The aggregate as the tenant sees it (null for other tenants' aggregates).</summary>
    public async Task<Snapshot?> LoadAsync(string tenantId, string aggregateId)
    {
        await using var cmd = _db.CreateCommand($"SELECT state, version FROM {_s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3");
        cmd.Parameters.Add(new() { Value = tenantId });
        cmd.Parameters.Add(new() { Value = AggregateType });
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

  const topologyCs = `using RabbitMQ.Client;

${n}
/// <summary>Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ.</summary>
public sealed record Topology(string Exchange, string Queue, string Dlx, string Dlq)
{
    public static readonly Topology Default = new(${cs(t.exchange)}, ${cs(t.queue)}, ${cs(t.dlx)}, ${cs(t.dlq)});

    public static Topology ForPrefix(string prefix) => new($"{prefix}.events", $"{prefix}.consumer", $"{prefix}.dlx", $"{prefix}.dlq");

    public void Declare(IModel channel)
    {
        channel.ExchangeDeclare(Exchange, "topic", durable: true);
        channel.ExchangeDeclare(Dlx, "fanout", durable: true);
        channel.QueueDeclare(Dlq, durable: true, exclusive: false, autoDelete: false);
        channel.QueueBind(Dlq, Dlx, "");
        channel.QueueDeclare(Queue, durable: true, exclusive: false, autoDelete: false, arguments: new Dictionary<string, object> { ["x-dead-letter-exchange"] = Dlx });
        channel.QueueBind(Queue, Exchange, "#");
    }
}
`;

  const relay = `using System.Diagnostics;
using System.Text;
using Npgsql;
using RabbitMQ.Client;

${n}
/// <summary>
/// Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
/// concurrent relays never publish the same row; publisher confirms guarantee delivery to the broker
/// before a row is marked published. Use one relay (and channel) per thread.
/// </summary>
public sealed class OutboxRelay
{
    private readonly NpgsqlDataSource _db;
    private readonly IModel _channel;
    private readonly string _exchange;
    private readonly string _s;
    public int LeaseSeconds { get; init; } = ${LEASE_SECONDS};
    public int MaxAttempts { get; init; } = ${MAX_PUBLISH_ATTEMPTS};

    public OutboxRelay(NpgsqlDataSource db, IModel channel, string exchange, string? schema = null)
    {
        _db = db;
        _channel = channel;
        _exchange = exchange;
        _s = Schema.Name(schema);
        _channel.ConfirmSelect();
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
            using var activity = Telemetry.Source.StartActivity($"{_exchange} publish", ActivityKind.Producer, Telemetry.ParentFrom(row.Traceparent));
            activity?.SetTag("messaging.system", "rabbitmq");
            activity?.SetTag("messaging.destination.name", _exchange);
            activity?.SetTag("messaging.message.id", row.Id);
            activity?.SetTag("tenant.id", row.TenantId);
            try
            {
                var props = _channel.CreateBasicProperties();
                props.MessageId = row.Id;
                props.Persistent = true;
                props.ContentType = "application/json";
                props.Type = row.EventType;
                props.Headers = new Dictionary<string, object> { ["tenant_id"] = row.TenantId };
                if (Telemetry.TraceparentOf(activity) is { } traceparent) props.Headers["traceparent"] = traceparent;
                _channel.BasicPublish(_exchange, row.EventType, props, Encoding.UTF8.GetBytes(row.Payload));
                _channel.WaitForConfirmsOrDie(TimeSpan.FromSeconds(10));
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
using System.Text;
using System.Text.Json;
using Npgsql;
using RabbitMQ.Client;

${n}
/// <summary>
/// Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
/// handler, so redeliveries are acknowledged without running the handler twice. A handler error
/// rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
/// </summary>
public sealed class InboxConsumer
{
    public sealed record Meta(string MessageId, string? TenantId, string? EventType, NpgsqlConnection Connection);

    private readonly NpgsqlDataSource _db;
    private readonly IModel _channel;
    private readonly string _queue;
    private readonly string _name;
    private readonly Func<JsonElement, Meta, Task> _handler;
    private readonly string _s;

    public InboxConsumer(NpgsqlDataSource db, IModel channel, string queue, string consumerName, Func<JsonElement, Meta, Task> handler, string? schema = null)
    {
        _db = db;
        _channel = channel;
        _queue = queue;
        _name = consumerName;
        _handler = handler;
        _s = Schema.Name(schema);
    }

    /// <summary>Processes messages until the queue stays empty for <paramref name="idle"/>; returns how many were processed.</summary>
    public async Task<int> DrainAsync(TimeSpan idle)
    {
        var processed = 0;
        var idleSince = DateTime.UtcNow;
        while (DateTime.UtcNow - idleSince < idle)
        {
            var message = _channel.BasicGet(_queue, autoAck: false);
            if (message is null)
            {
                await Task.Delay(50);
                continue;
            }
            await ProcessAsync(message);
            processed++;
            idleSince = DateTime.UtcNow;
        }
        return processed;
    }

    private static string? Header(IBasicProperties props, string key) =>
        props.Headers is not null && props.Headers.TryGetValue(key, out var value)
            ? value is byte[] bytes ? Encoding.UTF8.GetString(bytes) : value?.ToString()
            : null;

    private async Task ProcessAsync(BasicGetResult message)
    {
        var props = message.BasicProperties;
        using var activity = Telemetry.Source.StartActivity($"{_queue} process", ActivityKind.Consumer, Telemetry.ParentFrom(Header(props, "traceparent")));
        activity?.SetTag("messaging.system", "rabbitmq");
        activity?.SetTag("messaging.destination.name", _queue);
        activity?.SetTag("messaging.message.id", props.MessageId);
        try
        {
            await using var conn = await _db.OpenConnectionAsync();
            await using var tx = await conn.BeginTransactionAsync();
            if (await CommandService.Exec(conn, $"INSERT INTO {_s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", CancellationToken.None, _name, props.MessageId) == 1)
            {
                using var json = JsonDocument.Parse(message.Body);
                await _handler(json.RootElement.Clone(), new Meta(props.MessageId, Header(props, "tenant_id"), props.Type, conn));
            }
            await tx.CommitAsync();
            _channel.BasicAck(message.DeliveryTag, multiple: false);
        }
        catch (Exception e)
        {
            activity?.SetStatus(ActivityStatusCode.Error, e.Message);
            _channel.BasicNack(message.DeliveryTag, multiple: false, requeue: false);
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
using RabbitMQ.Client;
using Xunit;

namespace ${ns}.Tests.Runtime;

/// <summary>Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and AMQP_URL.</summary>
[Trait("Category", "Integration")]
[Collection("runtime")]
public sealed class RuntimeIntegrationTests : IAsyncLifetime
{
    private const string Command = ${cs(first.snake)};
    private const string Event = ${cs(first.event)};
    private readonly NpgsqlDataSource _db;
    private readonly IConnection _amqp;
    private readonly string _schema;
    private readonly Topology _topology;

    public RuntimeIntegrationTests()
    {
        var dbUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
        var amqpUrl = Environment.GetEnvironmentVariable("AMQP_URL");
        if (string.IsNullOrEmpty(dbUrl) || string.IsNullOrEmpty(amqpUrl))
            throw new InvalidOperationException("Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).");
        _db = Connections.FromUrl(dbUrl);
        _amqp = new ConnectionFactory { Uri = new Uri(amqpUrl) }.CreateConnection();
        var uid = Guid.NewGuid().ToString("N")[..12];
        _schema = $"it_{uid}";
        _topology = Topology.ForPrefix($"it-{uid}");
    }

    public Task InitializeAsync() => Schema.MigrateAsync(_db, _schema);

    public async Task DisposeAsync()
    {
        await using (var cmd = _db.CreateCommand($"DROP SCHEMA IF EXISTS {_schema} CASCADE")) await cmd.ExecuteNonQueryAsync();
        _amqp.Dispose();
        await _db.DisposeAsync();
    }

    private async Task<long> Count(string table, string where = "true", params object[] args)
    {
        await using var cmd = _db.CreateCommand($"SELECT count(*) FROM {_schema}.{table} WHERE {where}");
        foreach (var a in args) cmd.Parameters.Add(new NpgsqlParameter { Value = a });
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    private static List<BasicGetResult> DrainQueue(IModel channel, string queue)
    {
        var messages = new List<BasicGetResult>();
        for (var m = channel.BasicGet(queue, autoAck: true); m is not null; m = channel.BasicGet(queue, autoAck: true)) messages.Add(m);
        return messages;
    }

    private static async Task WaitFor(Func<bool> check)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!check())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("Timed out waiting for condition");
            await Task.Delay(50);
        }
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
        using var setup = _amqp.CreateModel();
        _topology.Declare(setup);
        async Task<int> Drain(string worker)
        {
            using var channel = _amqp.CreateModel();
            var relay = new OutboxRelay(_db, channel, _topology.Exchange, _schema);
            var total = 0;
            for (var n = await relay.PublishBatchAsync(worker, 3); n > 0; n = await relay.PublishBatchAsync(worker, 3)) total += n;
            return total;
        }
        var totals = await Task.WhenAll(Task.Run(() => Drain("relay-a")), Task.Run(() => Drain("relay-b")));
        Assert.Equal(20, totals.Sum());
        Assert.Equal(0, await Count("ghk_outbox", "published_at IS NULL"));
        await WaitFor(() => setup.QueueDeclarePassive(_topology.Queue).MessageCount == 20);
        Assert.Equal(20, DrainQueue(setup, _topology.Queue).Select(m => m.BasicProperties.MessageId).Distinct().Count());
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
        using var channel = _amqp.CreateModel();
        _topology.Declare(channel);
        var handled = new List<string>();
        var consumer = new InboxConsumer(_db, channel, _topology.Queue, "it-consumer", (json, meta) =>
        {
            if (json.TryGetProperty("poison", out _)) throw new InvalidOperationException("cannot process");
            handled.Add(meta.MessageId);
            return Task.CompletedTask;
        }, _schema);
        foreach (var (id, body) in new[] { ("m-1", "{\\"ok\\": true}"), ("m-1", "{\\"ok\\": true}"), ("m-poison", "{\\"poison\\": true}") })
        {
            var props = channel.CreateBasicProperties();
            props.MessageId = id;
            props.Headers = new Dictionary<string, object> { ["tenant_id"] = "t1" };
            channel.BasicPublish(_topology.Exchange, "Test", props, Encoding.UTF8.GetBytes(body));
        }
        await consumer.DrainAsync(TimeSpan.FromSeconds(1));
        Assert.Equal(new[] { "m-1" }, handled);
        Assert.Equal(1, await Count("ghk_inbox", "consumer = $1", "it-consumer"));
        await WaitFor(() => channel.QueueDeclarePassive(_topology.Dlq).MessageCount == 1);
        Assert.Equal(new[] { "m-poison" }, DrainQueue(channel, _topology.Dlq).Select(m => m.BasicProperties.MessageId));
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
        using var channel = _amqp.CreateModel();
        _topology.Declare(channel);
        Assert.Equal(1, await new OutboxRelay(_db, channel, _topology.Exchange, _schema).PublishBatchAsync("relay", 10));
        var received = 0;
        using var consumerChannel = _amqp.CreateModel();
        await new InboxConsumer(_db, consumerChannel, _topology.Queue, "trace-consumer", (_, _) => { received++; return Task.CompletedTask; }, _schema).DrainAsync(TimeSpan.FromSeconds(1));
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
    { filename: 'src/Runtime/OutboxRelay.cs', content: relay },
    { filename: 'src/Runtime/InboxConsumer.cs', content: inbox },
    { filename: 'src/Runtime/SagaOrchestrator.cs', content: saga },
    { filename: `${testsDir}/Runtime/RuntimeIntegrationTests.cs`, content: test }
  ];
}
