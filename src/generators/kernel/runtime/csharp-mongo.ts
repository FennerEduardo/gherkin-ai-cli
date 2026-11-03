/* ==========================================================================
   gherkin-ai-cli - The .NET runtime kernel on MongoDB 8 (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). ASP.NET Core.

   Same design as the TypeScript kernel on MongoDB (typescript-mongo.ts):
     - Runtime/Connections.cs: Connections.FromUrl returns a KernelDatabase
       (one MongoClient of MongoDB.Driver, Apache-2.0) instead of an
       NpgsqlDataSource, with InTransactionAsync: a transaction run again on a
       transient error, a write conflict or a duplicate key from a concurrent
       insert (PostgreSQL's row locks wait for the other writer instead);
     - collections with the kernel's column names and unique indexes; a
       schema is a database ("public" is the one in DATABASE_URL);
     - the command service and the inbox in transactions; the outbox claimed
       one event at a time with an atomic FindOneAndUpdate and a lease on the
       server's clock ($$NOW);
     - the application layer and the tests use KernelDatabase where they used
       NpgsqlDataSource.
   Transactions need a replica set (one node is enough).
   ========================================================================== */

import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS } from './shared';

type File = { filename: string; content: string };

/** MongoDB's official .NET driver (Apache-2.0). */
export const CS_MONGO_PACKAGE = '<PackageReference Include="MongoDB.Driver" Version="3.4.0" />';

const nsOf = (content: string) => content.match(/^namespace ([\w.]+);/m)?.[1] ?? '';

function connectionsCs(ns: string): string {
  return `using MongoDB.Bson;
using MongoDB.Driver;

namespace ${ns};

/// <summary>
/// The kernel's MongoDB connection (stack.kernelDatabase "mongodb"): one MongoClient, pooled and thread-safe.
/// Transactions need a replica set; one node is enough.
/// </summary>
public sealed class KernelDatabase : IAsyncDisposable
{
    /// <summary>WriteConflict, DuplicateKey (a concurrent insert of the same key), NoSuchTransaction.</summary>
    private static readonly HashSet<int> RetryableCodes = new() { 112, 11000, 251 };

    public KernelDatabase(string url)
    {
        var mongoUrl = MongoUrl.Create(url);
        Client = new MongoClient(mongoUrl);
        DefaultDatabase = string.IsNullOrEmpty(mongoUrl.DatabaseName) ? "app" : mongoUrl.DatabaseName;
    }

    public MongoClient Client { get; }

    /// <summary>The database in DATABASE_URL.</summary>
    public string DefaultDatabase { get; }

    public IMongoDatabase Database(string name) => Client.GetDatabase(name);

    public IMongoCollection<BsonDocument> Collection(string database, string name) => Client.GetDatabase(database).GetCollection<BsonDocument>(name);

    /// <summary>Readiness probe.</summary>
    public Task PingAsync(CancellationToken ct = default) =>
        Client.GetDatabase(DefaultDatabase).RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1), cancellationToken: ct);

    /// <summary>
    /// Runs work in a transaction (snapshot reads, majority writes). On a transient error, a write conflict or a
    /// duplicate key from a concurrent transaction the work runs again on fresh data: the concurrent writer has
    /// committed by then, as a PostgreSQL row lock would have waited for it. Other errors propagate.
    /// </summary>
    public async Task<T> InTransactionAsync<T>(Func<IClientSessionHandle, Task<T>> work, CancellationToken ct = default)
    {
        for (var attempt = 1; ; attempt++)
        {
            using var session = await Client.StartSessionAsync(cancellationToken: ct);
            session.StartTransaction(new TransactionOptions(readConcern: ReadConcern.Snapshot, writeConcern: WriteConcern.WMajority));
            try
            {
                var result = await work(session);
                await CommitAsync(session, ct);
                return result;
            }
            catch (Exception e)
            {
                if (session.IsInTransaction)
                {
                    try { await session.AbortTransactionAsync(CancellationToken.None); } catch (MongoException) { }
                }
                if (attempt < 60 && IsRetryable(e))
                {
                    await Task.Delay(Math.Min(5 * attempt, 100), ct);
                    continue;
                }
                throw;
            }
        }
    }

    private static async Task CommitAsync(IClientSessionHandle session, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await session.CommitTransactionAsync(ct);
                return;
            }
            catch (MongoException e) when (attempt < 5 && e.HasErrorLabel("UnknownTransactionCommitResult"))
            {
            }
        }
    }

    private static bool IsRetryable(Exception e) =>
        e is MongoException m && (m.HasErrorLabel("TransientTransactionError") || RetryableCodes.Contains(CodeOf(m)));

    private static int CodeOf(MongoException e) => e switch
    {
        MongoWriteException w => w.WriteError?.Code ?? 0,
        MongoCommandException c => c.Code,
        _ => 0
    };

    public ValueTask DisposeAsync()
    {
        Client.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>Builds the kernel's MongoDB connection from DATABASE_URL: mongodb://host:27017/database?replicaSet=rs0</summary>
public static class Connections
{
    public static KernelDatabase FromUrl(string databaseUrl) => new(databaseUrl);
}
`;
}

function schemaCs(ns: string): string {
  return `using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ${ns};

/// <summary>The kernel's collections on MongoDB (docs/RUNTIME-KERNEL.md): a schema is a database.</summary>
public static class Schema
{
    /// <summary>Collections and their keys (unique indexes).</summary>
    private static readonly (string Name, string[][] Keys)[] Collections =
    {
        ("ghk_aggregates", new[] { new[] { "tenant_id", "aggregate_type", "id" } }),
        ("ghk_outbox", Array.Empty<string[]>()),
        ("ghk_idempotency", new[] { new[] { "tenant_id", "key" } }),
        ("ghk_inbox", new[] { new[] { "consumer", "message_id" } }),
        ("ghk_sagas", Array.Empty<string[]>())
    };

    // Tenant isolation is the repository filter (tenant_id in every query).

    /// <summary>Validated database name; "public" (or none) is the database of DATABASE_URL.</summary>
    public static string Name(string? schema, KernelDatabase db)
    {
        var s = string.IsNullOrEmpty(schema) || schema == "public" ? db.DefaultDatabase : schema;
        if (!Regex.IsMatch(s, "^[A-Za-z0-9_-]{1,63}$")) throw new ArgumentException($"Invalid schema name: {s}");
        return s;
    }

    /// <summary>Creates the collections and indexes (idempotent); they exist before any transaction writes to them.</summary>
    public static async Task MigrateAsync(KernelDatabase db, string? schema = null)
    {
        var database = db.Database(Name(schema, db));
        var existing = await (await database.ListCollectionNamesAsync()).ToListAsync();
        foreach (var (name, keys) in Collections)
        {
            if (!existing.Contains(name))
            {
                try { await database.CreateCollectionAsync(name); }
                catch (MongoCommandException e) when (e.Code == 48) { } // created by a replica starting at the same time
            }
            var collection = database.GetCollection<BsonDocument>(name);
            foreach (var key in keys)
            {
                var index = Builders<BsonDocument>.IndexKeys.Combine(key.Select(k => Builders<BsonDocument>.IndexKeys.Ascending(k)));
                await collection.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(index, new CreateIndexOptions { Unique = true }));
            }
        }
        await database.GetCollection<BsonDocument>("ghk_outbox").Indexes.CreateOneAsync(
            new CreateIndexModel<BsonDocument>(Builders<BsonDocument>.IndexKeys.Ascending("published_at").Ascending("failed_at").Ascending("created_at")));
    }
}
`;
}

const COMMAND_SERVICE_TAIL = `    private readonly KernelDatabase _db;
    private readonly string _s;

    public CommandService(KernelDatabase db, string? schema = null)
    {
        _db = db;
        _s = Schema.Name(schema, db);
    }

    public async Task<Result> HandleAsync(Request req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(req.TenantId)) throw new DomainValidationException("TenantId is required");
        using var activity = Telemetry.Source.StartActivity($"{req.Type}.{req.Command}", ActivityKind.Internal, Telemetry.ParentFrom(req.Traceparent));
        activity?.SetTag("tenant.id", req.TenantId);
        activity?.SetTag("aggregate.id", req.AggregateId);
        try
        {
            var traceparent = Telemetry.TraceparentOf(activity);
            // A concurrent change of the same aggregate is a write conflict: the transaction runs again on its result.
            return await _db.InTransactionAsync(session => ExecuteAsync(session, req, traceparent, ct), ct);
        }
        catch (Exception e)
        {
            activity?.SetStatus(ActivityStatusCode.Error, e.Message);
            throw;
        }
    }

    private async Task<Result> ExecuteAsync(IClientSessionHandle session, Request req, string? traceparent, CancellationToken ct)
    {
        var idempotency = _db.Collection(_s, "ghk_idempotency");
        if (req.IdempotencyKey is { } key)
        {
            var claim = new BsonDocument { { "tenant_id", req.TenantId }, { "key", key } };
            var done = await idempotency.Find(session, claim).FirstOrDefaultAsync(ct);
            if (done is not null)
            {
                if (done["status"].AsString == "COMPLETED")
                {
                    var stored = JsonSerializer.Deserialize<Result>(done["response"].AsString)!;
                    return stored with { Status = "replayed" };
                }
                return new Result("in-progress", req.AggregateId);
            }
            await idempotency.InsertOneAsync(session, new BsonDocument(claim) { { "status", "PROCESSING" }, { "created_at", DateTime.UtcNow } }, cancellationToken: ct);
        }

        if (!Aggregates.TryGetValue(req.Type, out var apply)) throw new DomainValidationException($"Unknown aggregate type {req.Type}");
        var aggregates = _db.Collection(_s, "ghk_aggregates");
        var id = new BsonDocument { { "tenant_id", req.TenantId }, { "aggregate_type", req.Type }, { "id", req.AggregateId } };
        var row = await aggregates.Find(session, id).FirstOrDefaultAsync(ct);
        var applied = apply(req.AggregateId, row?["state"].AsString, row is null ? 0 : row["version"].ToInt64(), req.Command, req.Payload);

        await aggregates.UpdateOneAsync(session, id,
            new BsonDocument("$set", new BsonDocument { { "state", applied.State }, { "version", applied.Version }, { "updated_at", DateTime.UtcNow } }),
            new UpdateOptions { IsUpsert = true }, ct);
        await _db.Collection(_s, "ghk_outbox").InsertOneAsync(session, new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString() }, { "tenant_id", req.TenantId }, { "aggregate_id", req.AggregateId }, { "event_type", applied.EventType },
            { "payload", JsonSerializer.Serialize(applied.Event, applied.Event.GetType()) },
            { "traceparent", traceparent is null ? BsonNull.Value : new BsonString(traceparent) }, { "created_at", DateTime.UtcNow },
            { "claimed_by", BsonNull.Value }, { "claimed_until", BsonNull.Value }, { "published_at", BsonNull.Value },
            { "attempts", 0 }, { "last_error", BsonNull.Value }, { "failed_at", BsonNull.Value }
        }, cancellationToken: ct);
        var result = new Result("created", req.AggregateId, applied.EventType, applied.EventVersion);
        if (req.IdempotencyKey is { } completedKey)
        {
            await idempotency.UpdateOneAsync(session, new BsonDocument { { "tenant_id", req.TenantId }, { "key", completedKey } },
                new BsonDocument("$set", new BsonDocument { { "status", "COMPLETED" }, { "response", JsonSerializer.Serialize(result) } }), cancellationToken: ct);
        }
        return result;
    }

    /// <summary>The aggregate as the tenant sees it (null for other tenants' aggregates).</summary>
    public async Task<Snapshot?> LoadAsync(string tenantId, string aggregateId, string aggregateType = DefaultAggregate)
    {
        var row = await _db.Collection(_s, "ghk_aggregates")
            .Find(new BsonDocument { { "tenant_id", tenantId }, { "aggregate_type", aggregateType }, { "id", aggregateId } }).FirstOrDefaultAsync();
        return row is null ? null : new Snapshot(row["state"].AsString, row["version"].ToInt64());
    }
}
`;

function relayCs(ns: string): string {
  return `using System.Diagnostics;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;

namespace ${ns};

/// <summary>
/// Publishes pending outbox events. Each one is claimed with an atomic FindOneAndUpdate and a lease on the server's
/// clock, so concurrent relays never publish the same event; the publisher returns only once the broker has accepted
/// the message, before it is marked published. Use one relay (and publisher) per worker.
/// </summary>
public sealed class OutboxRelay
{
    private readonly KernelDatabase _db;
    private readonly IEventPublisher _publisher;
    private readonly string _s;
    public int LeaseSeconds { get; init; } = ${LEASE_SECONDS};
    public int MaxAttempts { get; init; } = ${MAX_PUBLISH_ATTEMPTS};

    public OutboxRelay(KernelDatabase db, IEventPublisher publisher, string? schema = null)
    {
        _db = db;
        _publisher = publisher;
        _s = Schema.Name(schema, db);
    }

    private static PipelineDefinition<BsonDocument, BsonDocument> Set(BsonDocument fields) =>
        PipelineDefinition<BsonDocument, BsonDocument>.Create(new[] { new BsonDocument("$set", fields) });

    /// <summary>The oldest pending event nobody holds a lease on, leased to workerId (null when there is none).</summary>
    private Task<BsonDocument> ClaimAsync(IMongoCollection<BsonDocument> outbox, string workerId, CancellationToken ct)
    {
        var pending = new BsonDocument
        {
            { "published_at", BsonNull.Value }, { "failed_at", BsonNull.Value },
            { "$or", new BsonArray { new BsonDocument("claimed_until", BsonNull.Value), new BsonDocument("$expr", new BsonDocument("$lt", new BsonArray { "$claimed_until", "$$NOW" })) } }
        };
        var lease = Set(new BsonDocument
        {
            { "claimed_by", new BsonDocument("$literal", workerId) },
            { "claimed_until", new BsonDocument("$add", new BsonArray { "$$NOW", LeaseSeconds * 1000L }) },
            { "attempts", new BsonDocument("$add", new BsonArray { "$attempts", 1 }) }
        });
        return outbox.FindOneAndUpdateAsync<BsonDocument>(pending, Builders<BsonDocument>.Update.Pipeline(lease),
            new FindOneAndUpdateOptions<BsonDocument> { Sort = new BsonDocument { { "created_at", 1 }, { "_id", 1 } }, ReturnDocument = ReturnDocument.After }, ct);
    }

    public async Task<int> PublishBatchAsync(string workerId, int limit = 50, CancellationToken ct = default)
    {
        var outbox = _db.Collection(_s, "ghk_outbox");
        var published = 0;
        for (var n = 0; n < limit; n++)
        {
            var row = await ClaimAsync(outbox, workerId, ct);
            if (row is null) break;
            var id = row["_id"].AsString;
            var tenantId = row["tenant_id"].AsString;
            var incoming = row["traceparent"].IsBsonNull ? null : row["traceparent"].AsString;
            using var activity = Telemetry.Source.StartActivity($"{_publisher.Destination} publish", ActivityKind.Producer, Telemetry.ParentFrom(incoming));
            activity?.SetTag("messaging.system", _publisher.MessagingSystem);
            activity?.SetTag("messaging.destination.name", _publisher.Destination);
            activity?.SetTag("messaging.message.id", id);
            activity?.SetTag("tenant.id", tenantId);
            try
            {
                await _publisher.PublishAsync(new BrokerMessage(id, row["event_type"].AsString, tenantId, Telemetry.TraceparentOf(activity), Encoding.UTF8.GetBytes(row["payload"].AsString)), ct);
                await outbox.UpdateOneAsync(new BsonDocument { { "_id", id }, { "claimed_by", workerId } },
                    Builders<BsonDocument>.Update.Pipeline(Set(new BsonDocument { { "published_at", "$$NOW" }, { "claimed_until", BsonNull.Value } })), cancellationToken: ct);
                published++;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Message);
                await outbox.UpdateOneAsync(new BsonDocument("_id", id), Builders<BsonDocument>.Update.Pipeline(Set(new BsonDocument
                {
                    { "claimed_until", BsonNull.Value },
                    { "last_error", new BsonDocument("$literal", e.Message) },
                    { "failed_at", new BsonDocument("$cond", new BsonArray { new BsonDocument("$gte", new BsonArray { "$attempts", MaxAttempts }), "$$NOW", BsonNull.Value }) }
                })), cancellationToken: ct);
            }
        }
        return published;
    }
}
`;
}

function sagaCs(ns: string): string {
  return `using MongoDB.Bson;
using MongoDB.Driver;

namespace ${ns};

/// <summary>
/// Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
/// are compensated in reverse order. Re-running a saga id resumes after its completed steps.
/// </summary>
public sealed class SagaOrchestrator
{
    public sealed record Step(string Name, Func<Task> Action, Func<Task> Compensate);

    public sealed record Status(string Value, IReadOnlyList<string> CompletedSteps);

    private readonly KernelDatabase _db;
    private readonly string _s;

    public SagaOrchestrator(KernelDatabase db, string? schema = null)
    {
        _db = db;
        _s = Schema.Name(schema, db);
    }

    private IMongoCollection<BsonDocument> Sagas => _db.Collection(_s, "ghk_sagas");

    public async Task<string> RunAsync(string sagaId, string tenantId, IReadOnlyList<Step> steps)
    {
        try
        {
            await Sagas.UpdateOneAsync(new BsonDocument("_id", sagaId),
                new BsonDocument("$setOnInsert", new BsonDocument { { "tenant_id", tenantId }, { "status", "RUNNING" }, { "completed_steps", "" }, { "updated_at", DateTime.UtcNow } }),
                new UpdateOptions { IsUpsert = true });
        }
        catch (MongoWriteException e) when (e.WriteError?.Code == 11000)
        {
            // a concurrent run created it
        }
        var row = await Sagas.Find(new BsonDocument { { "_id", sagaId }, { "tenant_id", tenantId } }).FirstOrDefaultAsync();
        var completed = new List<string>(row is null ? Array.Empty<string>() : Split(row["completed_steps"].AsString));
        foreach (var step in steps)
        {
            if (completed.Contains(step.Name)) continue;
            try
            {
                await step.Action();
            }
            catch
            {
                await Save(sagaId, "COMPENSATING", completed);
                for (var i = completed.Count - 1; i >= 0; i--)
                {
                    await steps.First(s => s.Name == completed[i]).Compensate();
                    completed.RemoveAt(i);
                    await Save(sagaId, "COMPENSATING", completed);
                }
                await Save(sagaId, "COMPENSATED", completed);
                return "COMPENSATED";
            }
            completed.Add(step.Name);
            await Save(sagaId, "RUNNING", completed);
        }
        await Save(sagaId, "COMPLETED", completed);
        return "COMPLETED";
    }

    public async Task<Status?> StatusAsync(string sagaId)
    {
        var row = await Sagas.Find(new BsonDocument("_id", sagaId)).FirstOrDefaultAsync();
        return row is null ? null : new Status(row["status"].AsString, Split(row["completed_steps"].AsString));
    }

    private static string[] Split(string done) => done.Length == 0 ? Array.Empty<string>() : done.Split(',');

    private Task Save(string sagaId, string status, List<string> completed) =>
        Sagas.UpdateOneAsync(new BsonDocument("_id", sagaId),
            new BsonDocument("$set", new BsonDocument { { "status", status }, { "completed_steps", string.Join(',', completed) }, { "updated_at", DateTime.UtcNow } }));
}
`;
}

const INBOX_BLOCK = / {12}await using var conn = await _db\.OpenConnectionAsync\(\);\n[\s\S]*? {12}await tx\.CommitAsync\(\);\n/;
const INBOX_MONGO = `            var database = _db.Database(_s);
            await _db.InTransactionAsync(async session =>
            {
                var inbox = database.GetCollection<BsonDocument>("ghk_inbox");
                var key = new BsonDocument { { "consumer", _name }, { "message_id", message.MessageId } };
                if (await inbox.Find(session, key).AnyAsync()) return true;
                await inbox.InsertOneAsync(session, new BsonDocument(key) { { "processed_at", DateTime.UtcNow } });
                using var json = JsonDocument.Parse(message.Body);
                await _handler(json.RootElement.Clone(), new Meta(message.MessageId, message.TenantId, message.EventType, session, database));
                return true;
            });
`;

const MONGO_USINGS = 'using MongoDB.Bson;\nusing MongoDB.Driver;';

/** Adapts a generated ASP.NET Core project (PostgreSQL kernel) to MongoDB; also its csproj (contracts.ts). */
export function mongoizeCsProject(files: File[]): File[] {
  return files.map(f => {
    const ns = nsOf(f.content);
    if (/(^|\/)Runtime\/Connections\.cs$/.test(f.filename)) return { ...f, content: connectionsCs(ns) };
    if (/(^|\/)Runtime\/Schema\.cs$/.test(f.filename) && f.content.includes('public static class Schema')) return { ...f, content: schemaCs(ns) };
    if (/(^|\/)Runtime\/OutboxRelay\.cs$/.test(f.filename)) return { ...f, content: relayCs(ns) };
    if (/(^|\/)Runtime\/SagaOrchestrator\.cs$/.test(f.filename)) return { ...f, content: sagaCs(ns) };
    if (/(^|\/)Runtime\/CommandService\.cs$/.test(f.filename)) {
      return {
        ...f, content: f.content
          .replace('using Npgsql;', MONGO_USINGS)
          .replace(/\/\/\/ Executes a command in one transaction: idempotency claim, aggregate load \(FOR UPDATE\), domain\n\/\/\/ logic, aggregate save and outbox insert\. A domain error rolls back everything\./,
            '/// Executes a command in one MongoDB transaction: idempotency lookup, aggregate load, domain logic,\n/// aggregate save and outbox insert. A domain error aborts everything; a concurrent writer makes it run again.')
          .replace(/ {4}private readonly NpgsqlDataSource _db;[\s\S]*$/, () => COMMAND_SERVICE_TAIL)
      };
    }
    if (/(^|\/)Runtime\/InboxConsumer\.cs$/.test(f.filename)) {
      return {
        ...f, content: f.content
          .replace('using Npgsql;', MONGO_USINGS)
          .replace('NpgsqlConnection Connection);', 'IClientSessionHandle Session, IMongoDatabase Database);')
          .replace(/\bNpgsqlDataSource\b/g, 'KernelDatabase')
          .replace('_s = Schema.Name(schema);', '_s = Schema.Name(schema, db);')
          .replace(INBOX_BLOCK, () => INBOX_MONGO)
      };
    }
    if (f.filename.endsWith('.csproj')) return { ...f, content: f.content.replace('<PackageReference Include="Npgsql" Version="8.0.5" />', CS_MONGO_PACKAGE) };
    if (!f.filename.endsWith('.cs') || !/Npgsql/.test(f.content)) return f;
    // The application layer and the tests: KernelDatabase where they used NpgsqlDataSource.
    const usesBson = /RuntimeIntegrationTests\.cs$|HttpTests\.cs$/.test(f.filename);
    return {
      ...f, content: f.content
        .replace(/^using Npgsql;\n/m, usesBson ? `${MONGO_USINGS}\n` : '')
        .replace(/\bNpgsqlDataSource\b/g, 'KernelDatabase')
        .replace('await using (var cmd = _db.CreateCommand($"DROP SCHEMA IF EXISTS {_schema} CASCADE")) await cmd.ExecuteNonQueryAsync();', 'await _db.Client.DropDatabaseAsync(_schema);')
        .replace(/ {4}private async Task<long> Count\(string table, string where = "true", params object\[\] args\)\n {4}\{[\s\S]*?\n {4}\}\n/,
          '    private Task<long> Count(string collection, BsonDocument? filter = null) =>\n        _db.Collection(_schema, collection).CountDocumentsAsync(filter ?? new BsonDocument());\n')
        .replace(/Count\("(\w+)", "(\w+) = \$1", ("[^"]*")\)/g, 'Count("$1", new BsonDocument("$2", $3))')
        .replace(/Count\("(\w+)", "(\w+) IS NULL"\)/g, 'Count("$1", new BsonDocument("$2", BsonNull.Value))')
        .replace(/await using \(var cmd = _db\.CreateCommand\(\$"SELECT traceparent FROM \{_schema\}\.ghk_outbox"\)\)\n\s+Assert\.Contains\(("[^"]*"), \(string\)\(await cmd\.ExecuteScalarAsync\(\)\)!\);/,
          (_m, id: string) => `Assert.Contains(${id}, (await _db.Collection(_schema, "ghk_outbox").Find(new BsonDocument()).FirstAsync())["traceparent"].AsString);`)
        .replace(/await using var cmd = _db\.CreateCommand\("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = \$1"\);\n\s+cmd\.Parameters\.AddWithValue\(id\);\n\s+Assert\.Equal\(tenant, await cmd\.ExecuteScalarAsync\(\)\);/,
          'var row = await _db.Collection(_db.DefaultDatabase, "ghk_outbox").Find(new BsonDocument("aggregate_id", id)).FirstAsync();\n        Assert.Equal(tenant, row["tenant_id"].AsString);')
        .replace('HTTP contract of the application layer against PostgreSQL', 'HTTP contract of the application layer against MongoDB')
        .replace('(postgres://user:password@host:5432/db)', '(mongodb://host:27017/db?replicaSet=rs0)')
    };
  });
}
