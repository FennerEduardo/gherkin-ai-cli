/* ==========================================================================
   gherkin-ai-cli - Application layer for ASP.NET Core (minimal API) over the
   C# runtime kernel: endpoint, JWT tenant, NpgsqlDataSource from
   DATABASE_URL, CommandService, outbox relay BackgroundService, Program.cs.
   Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface CsAppFile {
  filename: string;
  content: string;
}

const cs = (s: string) => JSON.stringify(s);

export function renderAspNetAppLayer(m: DomainModel, ns: string, testsDir: string, claim: string, siblings: DomainModel[] = []): CsAppFile[] {
  const first = m.commands[0];
  const route = commandRoute(m);

  const jwt = `using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ${ns}.Api.Auth;

/// <summary>
/// HS256 bearer tokens. The tenant comes only from the ${cs(claim)} claim of a validated token, never from a
/// header such as X-Tenant-Id, and there is no default tenant.
/// </summary>
public static class JwtTenant
{
    public const string TenantClaim = ${cs(claim)};

    private static byte[] FromBase64Url(string s)
    {
        var padded = s.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '='));
    }

    private static string ToBase64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Tenant claim of a valid token (signature, exp, nbf checked), else null.</summary>
    public static string? TenantFrom(string? authorization, string? secret)
    {
        if (string.IsNullOrEmpty(secret) || authorization is null || !authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        var parts = authorization[7..].Trim().Split('.');
        if (parts.Length != 3) return null;
        try
        {
            using var header = JsonDocument.Parse(FromBase64Url(parts[0]));
            if (!header.RootElement.TryGetProperty("alg", out var alg) || alg.GetString() != "HS256") return null;
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
            var expected = hmac.ComputeHash(Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}"));
            if (!CryptographicOperations.FixedTimeEquals(expected, FromBase64Url(parts[2]))) return null;
            using var claims = JsonDocument.Parse(FromBase64Url(parts[1]));
            var root = claims.RootElement;
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (root.TryGetProperty("exp", out var exp) && exp.ValueKind == JsonValueKind.Number && now >= exp.GetInt64()) return null;
            if (root.TryGetProperty("nbf", out var nbf) && nbf.ValueKind == JsonValueKind.Number && now < nbf.GetInt64()) return null;
            return root.TryGetProperty(TenantClaim, out var tenant) && tenant.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(tenant.GetString()) ? tenant.GetString() : null;
        }
        catch (Exception e) when (e is FormatException or JsonException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Signs an HS256 token (tests and local tooling; production tokens come from your identity provider).</summary>
    public static string Sign(IDictionary<string, object> claims, string secret)
    {
        var head = ToBase64Url(Encoding.UTF8.GetBytes("{\\"alg\\":\\"HS256\\",\\"typ\\":\\"JWT\\"}"));
        var body = ToBase64Url(JsonSerializer.SerializeToUtf8Bytes(claims));
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return $"{head}.{body}.{ToBase64Url(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{head}.{body}")))}";
    }
}
`;

  const endpoints = `using System.Text.Json;
using ${ns}.Api.Auth;
using ${ns}.Domain.Kernel;
using ${ns}.Runtime;

namespace ${ns}.Api;

/// <summary>POST ${route}/{id}/{command} (${m.commands.map(c => c.snake).join(', ')}).</summary>
// ghk:implements ${m.pascal}
public static class ${m.pascal}Endpoints
{
    private static readonly Dictionary<string, int> StatusCodes = new() { ["created"] = 202, ["replayed"] = 200, ["in-progress"] = 409 };

    public static IEndpointRouteBuilder Map${m.pascal}Endpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(${cs(route + '/{id}/{command}')}, async (string id, string command, HttpRequest request, CommandService commands, IConfiguration config) =>
        {
            var tenant = JwtTenant.TenantFrom(request.Headers.Authorization.ToString(), config["Jwt:Secret"] ?? config["JWT_SECRET"]);
            if (tenant is null) return Results.Json(new { detail = "A valid bearer token with a tenant is required" }, statusCode: 401);
            Dictionary<string, object?>? payload = null;
            if (request.ContentLength is > 0) payload = await request.ReadFromJsonAsync<Dictionary<string, object?>>();
            try
            {
                var result = await commands.HandleAsync(new CommandService.Request(
                    tenant, id, command, payload,
                    request.Headers.TryGetValue("Idempotency-Key", out var key) ? key.ToString() : null,
                    request.Headers.TryGetValue("traceparent", out var tp) ? tp.ToString() : null,
                    ${cs(m.pascal)}));
                return Results.Json(result, statusCode: StatusCodes.GetValueOrDefault(result.Status, 200));
            }
            catch (DomainValidationException e)
            {
                return Results.Json(new { detail = e.Message }, statusCode: 422);
            }
        });
        return app;
    }
}
`;

  const worker = `using ${ns}.Runtime;
using Npgsql;

namespace ${ns}.Api.Workers;

/// <summary>
/// Publishes the outbox every ${RELAY_INTERVAL_MS} ms when a broker is configured (Runtime/Brokers.cs: GHK_BROKER,
/// AMQP_URL, PUBSUB_*, SERVICEBUS_*).
/// </summary>
public sealed class OutboxRelayWorker(NpgsqlDataSource db, IConfiguration config, ILogger<OutboxRelayWorker> logger) : BackgroundService
{
    private readonly string _workerId = $"${m.kebab}-{Guid.NewGuid()}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("Outbox:RelayEnabled", true)) return;
        if (!Brokers.Configured())
        {
            logger.LogWarning("No event broker is configured (AMQP_URL, PUBSUB_PROJECT_ID or SERVICEBUS_*): outbox events are stored but not published.");
            return;
        }
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var broker = await Brokers.ConnectAsync();
                await broker.DeclareAsync(Topology.Default, stoppingToken);
                await using var publisher = await broker.PublisherAsync(Topology.Default.Exchange, stoppingToken);
                var relay = new OutboxRelay(db, publisher);
                while (!stoppingToken.IsCancellationRequested)
                {
                    await relay.PublishBatchAsync(_workerId, 50, stoppingToken);
                    await Task.Delay(${RELAY_INTERVAL_MS}, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e)
            {
                logger.LogError(e, "Outbox relay failed; retrying");
                await Task.Delay(5000, stoppingToken).ContinueWith(_ => { });
            }
        }
    }
}
`;

  const program = `using ${ns}.Api;
using ${ns}.Api.Workers;
using ${ns}.Runtime;
using Npgsql;

// Application layer over the runtime kernel: POST ${route}/{id}/{command} with a JWT tenant,
// the CommandService (idempotency + outbox) and the outbox relay worker.
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(_ => Connections.FromUrl(builder.Configuration["DATABASE_URL"]
    ?? throw new InvalidOperationException("DATABASE_URL is not set (postgres://user:password@host:5432/db)")));
builder.Services.AddSingleton(sp => new CommandService(sp.GetRequiredService<NpgsqlDataSource>()));
builder.Services.AddHostedService<OutboxRelayWorker>();

var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
${[m, ...siblings].map(f => `app.Map${f.pascal}Endpoints();`).join('\n')}
app.Run();

public partial class Program { } // WebApplicationFactory<Program> in the tests
`;

  const httpTests = `using System.Net;
using System.Net.Http.Json;
using ${ns}.Api.Auth;
using ${ns}.Runtime;
using Microsoft.AspNetCore.Mvc.Testing;
using Npgsql;
using Xunit;

namespace ${ns}.Tests.Api;

/// <summary>HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL).</summary>
[Trait("Category", "Integration")]
// One collection: the HTTP tests of every feature migrate the same (public) schema, so they run one at a time.
[Collection("HttpApplicationLayer")]
public sealed class ${m.pascal}HttpTests : IAsyncLifetime
{
    private const string Secret = "integration-test-secret-with-32-chars!";
    private readonly WebApplicationFactory<Program> _factory = new WebApplicationFactory<Program>()
        // The relay is off here: its publish activities would mix with the runtime tests' trace assertions.
        .WithWebHostBuilder(b => b.UseSetting("Jwt:Secret", Secret).UseSetting("Outbox:RelayEnabled", "false"));
    private NpgsqlDataSource _db = null!;

    public async Task InitializeAsync()
    {
        _db = Connections.FromUrl(Environment.GetEnvironmentVariable("DATABASE_URL")!);
        await Schema.MigrateAsync(_db);
    }

    public async Task DisposeAsync()
    {
        await _factory.DisposeAsync();
        await _db.DisposeAsync();
    }

    private static string Bearer(string? tenant, string secret = Secret) =>
        "Bearer " + JwtTenant.Sign(tenant is null ? new Dictionary<string, object> { ["sub"] = "u1" } : new Dictionary<string, object> { [JwtTenant.TenantClaim] = tenant }, secret);

    private async Task<HttpResponseMessage> Post(string path, params (string Name, string Value)[] headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(new Dictionary<string, object>()) };
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        return await _factory.CreateClient().SendAsync(request);
    }

    [Fact]
    public async Task Rejects_requests_without_a_valid_token_and_never_trusts_X_Tenant_Id()
    {
        var path = $"${route}/{Guid.NewGuid()}/${first.snake}";
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(path)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(path, ("X-Tenant-Id", "acme"))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(path, ("Authorization", Bearer(null)))).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(path, ("Authorization", Bearer("acme", "wrong-secret")))).StatusCode);
    }

    [Fact]
    public async Task Runs_a_command_into_the_outbox_for_the_token_tenant_idempotently()
    {
        var tenant = $"tenant-{Guid.NewGuid()}";
        var id = Guid.NewGuid().ToString();
        var path = $"${route}/{id}/${first.snake}";
        var headers = new[] { ("Authorization", Bearer(tenant)), ("Idempotency-Key", Guid.NewGuid().ToString()), ("X-Tenant-Id", "someone-else") };
        Assert.Equal(HttpStatusCode.Accepted, (await Post(path, headers)).StatusCode);
        var replay = await Post(path, headers);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Contains("replayed", await replay.Content.ReadAsStringAsync());

        await using var cmd = _db.CreateCommand("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = $1");
        cmd.Parameters.AddWithValue(id);
        Assert.Equal(tenant, await cmd.ExecuteScalarAsync());
    }

    [Fact]
    public async Task Maps_domain_validation_errors_to_422()
    {
        var response = await Post($"${route}/{Guid.NewGuid()}/no_such_command", ("Authorization", Bearer("acme")));
        Assert.Equal((HttpStatusCode)422, response.StatusCode);
    }
}
`;

  return [
    { filename: 'src/Api/Auth/JwtTenant.cs', content: jwt },
    { filename: `src/Api/${m.pascal}Endpoints.cs`, content: endpoints },
    { filename: 'src/Api/Workers/OutboxRelayWorker.cs', content: worker },
    { filename: 'src/Api/Program.cs', content: program },
    { filename: `${testsDir}/Api/${m.pascal}HttpTests.cs`, content: httpTests }
  ];
}
