/* ==========================================================================
   gherkin-ai-cli - .NET runtime kernel on MySQL 8 (stack.kernelDatabase
   "mysql"; PLAN-3.3.0 X-01b). ASP.NET Core.

   Same approach as the other kernels (typescript-mysql.ts, jvm-mysql.ts,
   python-mysql.ts): the PostgreSQL kernel is generated, then adapted:
     - Npgsql -> MySqlConnector (MIT): MySqlDataSource, MySqlConnection,
       MySqlCommand, MySqlParameter. IgnoreCommandTransaction=true, so
       commands created on a connection join its open transaction (Npgsql's
       behaviour);
     - parameters: MySqlConnector takes positional `?`. Commands that bind
       their parameters in order get `?` in the text; CommandService.Exec,
       which also runs statements that use $n out of order or twice, turns
       $1..$n into `?` at run time and binds its arguments in that order;
     - a schema is a MySQL database (the tests use one per test; "public"
       is the database of DATABASE_URL); migrations serialized with GET_LOCK;
     - ON CONFLICT DO NOTHING -> INSERT IGNORE; the aggregate upsert ->
       ON DUPLICATE KEY UPDATE; `key` quoted; now() -> CURRENT_TIMESTAMP(6);
     - the outbox claim (UPDATE ... RETURNING does not exist in MySQL):
       SELECT ... FOR UPDATE SKIP LOCKED, UPDATE the lease, read back, in
       one transaction.
   Tenant isolation is the repository filter (tenant_id in every query):
   MySQL has no row-level security.
   ========================================================================== */

import { MYSQL_RUNTIME_TABLES, MYSQL_SCHEMA_TOKEN } from './typescript-mysql';

type File = { filename: string; content: string };

const cs = (s: string) => JSON.stringify(s);

/** MySqlConnector, MIT (https://mysqlconnector.net). */
export const CS_MYSQL_PACKAGE = '<PackageReference Include="MySqlConnector" Version="2.4.0" />';

function connectionsCs(n: string): string {
  return `using MySqlConnector;

${n}
/// <summary>Builds a MySqlConnector data source from mysql://user:password@host:3306/database[?ssl-mode=REQUIRED]</summary>
public static class Connections
{
    public static MySqlDataSource FromUrl(string databaseUrl)
    {
        var uri = new Uri(databaseUrl);
        var userInfo = uri.UserInfo.Split(':', 2);
        var builder = new MySqlConnectionStringBuilder
        {
            Server = uri.Host,
            Port = (uint)(uri.Port > 0 ? uri.Port : 3306),
            Database = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),
            UserID = Uri.UnescapeDataString(userInfo[0]),
            Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "",
            SslMode = MySqlSslMode.Preferred,
            AllowPublicKeyRetrieval = true,
            // Commands created on a connection join its open transaction, as with Npgsql.
            IgnoreCommandTransaction = true
        };
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            var key = kv[0].ToLowerInvariant().Replace("_", "-");
            var value = (kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "").ToLowerInvariant();
            if (key is "ssl-mode" or "sslmode")
                builder.SslMode = value switch
                {
                    "disable" or "disabled" => MySqlSslMode.None,
                    "require" or "required" => MySqlSslMode.Required,
                    "verify-ca" or "verify_ca" => MySqlSslMode.VerifyCA,
                    "verify-full" or "verify_identity" or "verify-identity" => MySqlSslMode.VerifyFull,
                    _ => MySqlSslMode.Preferred
                };
        }
        return new MySqlDataSource(builder.ConnectionString);
    }
}
`;
}

function schemaCs(n: string): string {
  return `using System.Text.RegularExpressions;
using MySqlConnector;

${n}
/// <summary>Runtime tables on MySQL 8 (docs/RUNTIME-KERNEL.md): a schema is a MySQL database.</summary>
public static class Schema
{
    private static readonly string[] Statements =
    {
${MYSQL_RUNTIME_TABLES.map(s => `        ${cs(s)},`).join('\n')}
    };

    // Tenant isolation is the repository filter (tenant_id in every query): MySQL has no row-level security.

    /// <summary>The database of the data source (DATABASE_URL's).</summary>
    public static string DefaultSchema(MySqlDataSource? db)
    {
        var database = db is null ? null : new MySqlConnectionStringBuilder(db.ConnectionString).Database;
        if (string.IsNullOrEmpty(database) && Environment.GetEnvironmentVariable("DATABASE_URL") is { } url)
            database = Uri.UnescapeDataString(new Uri(url).AbsolutePath.TrimStart('/'));
        return string.IsNullOrEmpty(database) ? "app" : database;
    }

    private static string Plain(string? schema, MySqlDataSource? db) =>
        string.IsNullOrEmpty(schema) || schema == "public" ? DefaultSchema(db) : schema;

    /// <summary>Validated, quoted database name; "public" is the data source's database.</summary>
    public static string Name(string? schema, MySqlDataSource? db = null)
    {
        var s = Plain(schema, db);
        if (!Regex.IsMatch(s, "^[A-Za-z0-9_$-]{1,64}$")) throw new ArgumentException($"Invalid schema name: {s}");
        return $"\`{s}\`";
    }

    /// <summary>
    /// Creates the runtime tables (idempotent); replicas starting together are serialized with a named lock.
    /// Another database than the data source's (tests) is created first; the service's own is never created here,
    /// so its user needs no global CREATE privilege.
    /// </summary>
    public static async Task MigrateAsync(MySqlDataSource db, string? schema = null)
    {
        var s = Name(schema, db);
        await using var conn = await db.OpenConnectionAsync();
        await Run(conn, "SELECT GET_LOCK('ghk_runtime_schema', 60)");
        try
        {
            if (Plain(schema, db) != DefaultSchema(db)) await Run(conn, $"CREATE DATABASE IF NOT EXISTS {s}");
            foreach (var statement in Statements) await Run(conn, statement.Replace(${cs(MYSQL_SCHEMA_TOKEN)}, s));
        }
        finally
        {
            await Run(conn, "SELECT RELEASE_LOCK('ghk_runtime_schema')");
        }
    }

    private static async Task Run(MySqlConnection conn, string sql)
    {
        await using var cmd = new MySqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }
}
`;
}

const EXEC_PG = `    internal static async Task<int> Exec(NpgsqlConnection conn, string sql, CancellationToken ct, params object?[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        foreach (var arg in args) cmd.Parameters.Add(new NpgsqlParameter { Value = arg ?? DBNull.Value });
        return await cmd.ExecuteNonQueryAsync(ct);
    }`;

const EXEC_MY = `    /// <summary>Runs a statement written with PostgreSQL-style numbered parameters (in any order, possibly repeated) as MySQL positional ones.</summary>
    internal static async Task<int> Exec(MySqlConnection conn, string sql, CancellationToken ct, params object?[] args)
    {
        var order = new List<int>();
        var text = System.Text.RegularExpressions.Regex.Replace(sql, @"\\$(\\d+)", m => { order.Add(int.Parse(m.Groups[1].Value) - 1); return "?"; });
        if (order.Count == 0) for (var i = 0; i < args.Length; i++) order.Add(i);
        await using var cmd = new MySqlCommand(text, conn);
        foreach (var i in order) cmd.Parameters.Add(new MySqlParameter { Value = args[i] ?? DBNull.Value });
        return await cmd.ExecuteNonQueryAsync(ct);
    }`;

/** The outbox claim in one transaction: MySQL's UPDATE returns no rows. */
const CLAIM = `        await using (var tx = await conn.BeginTransactionAsync(ct))
        {
            // MySQL has no UPDATE ... RETURNING: lock the next batch (SKIP LOCKED), lease it and read it back.
            var due = new List<string>();
            await using (var select = new MySqlCommand($"SELECT id FROM {_s}.ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL " +
                "AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(6)) ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED", conn)
            { Parameters = { new MySqlParameter { Value = limit } } })
            await using (var reader = await select.ExecuteReaderAsync(ct))
            {
                while (await reader.ReadAsync(ct)) due.Add(reader.GetString(0));
            }
            if (due.Count > 0)
            {
                var ids = string.Join(", ", Enumerable.Repeat("?", due.Count));
                var lease = new List<object?> { workerId, LeaseSeconds };
                lease.AddRange(due);
                await CommandService.Exec(conn, $"UPDATE {_s}.ghk_outbox SET claimed_by = ?, claimed_until = CURRENT_TIMESTAMP(6) + INTERVAL ? SECOND, " +
                    $"attempts = attempts + 1 WHERE id IN ({ids})", ct, lease.ToArray());
                await using var read = new MySqlCommand($"SELECT id, tenant_id, event_type, payload, traceparent FROM {_s}.ghk_outbox WHERE id IN ({ids}) ORDER BY created_at", conn);
                foreach (var id in due) read.Parameters.Add(new MySqlParameter { Value = id });
                await using var reader = await read.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct))
                    batch.Add(new Claimed(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4)));
            }
            await tx.CommitAsync(ct);
        }
`;

const CLAIM_BLOCK = / {8}await using \(var claim = new NpgsqlCommand\([\s\S]*?batch\.Add\([^\n]*\n {8}\}\n/;

/** [PostgreSQL text, MySQL text] pairs as they appear in the generated C# sources. */
const STATEMENTS: [string, string][] = [
  [`$"INSERT INTO {_s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING"`,
    `$"INSERT IGNORE INTO {_s}.ghk_idempotency (tenant_id, \`key\`, status) VALUES ($1, $2, 'PROCESSING')"`],
  [`ghk_idempotency WHERE tenant_id = $1 AND key = $2`, `ghk_idempotency WHERE tenant_id = $1 AND \`key\` = $2`],
  [`WHERE tenant_id = $1 AND key = $2", ct`, `WHERE tenant_id = $1 AND \`key\` = $2", ct`],
  [`"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"`,
    `"AS incoming ON DUPLICATE KEY UPDATE state = incoming.state, version = incoming.version, updated_at = CURRENT_TIMESTAMP(6)"`],
  [`$"INSERT INTO {_s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"`,
    `$"INSERT IGNORE INTO {_s}.ghk_inbox (consumer, message_id) VALUES ($1, $2)"`],
  [`$"INSERT INTO {_s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING') ON CONFLICT (id) DO NOTHING"`,
    `$"INSERT IGNORE INTO {_s}.ghk_sagas (id, tenant_id, status) VALUES ($1, $2, 'RUNNING')"`],
  [`_s = Schema.Name(schema);`, `_s = Schema.Name(schema, db);`],
  [EXEC_PG, EXEC_MY],
  // Runtime integration tests: a schema is a database.
  [`$"DROP SCHEMA IF EXISTS {_schema} CASCADE"`, `$"DROP DATABASE IF EXISTS {_schema}"`],
  [`"ghk_idempotency", "key = $1"`, `"ghk_idempotency", "\`key\` = $1"`],
  // DbDataSource.CreateCommand returns a DbCommand: its parameters are added by type.
  ['Parameters.Add(new() {', 'Parameters.Add(new MySqlParameter {'],
  ['cmd.Parameters.AddWithValue(id);', 'cmd.Parameters.Add(new MySqlParameter { Value = id });'],
  ['against PostgreSQL', 'against MySQL'],
  // Packages (csproj).
  ['<PackageReference Include="Npgsql" Version="8.0.5" />', CS_MYSQL_PACKAGE]
];

const TYPES: [RegExp, string][] = [
  [/\busing Npgsql;/g, 'using MySqlConnector;'],
  [/\bNpgsqlDataSource\b/g, 'MySqlDataSource'],
  [/\bNpgsqlConnection\b/g, 'MySqlConnection'],
  [/\bNpgsqlCommand\b/g, 'MySqlCommand'],
  [/\bNpgsqlParameter\b/g, 'MySqlParameter']
];

/** Adapts a generated ASP.NET Core project (PostgreSQL kernel) to MySQL; also its csproj (contracts.ts). */
export function mysqlizeCsProject(files: File[]): File[] {
  return files.map(f => {
    if (/(^|\/)Runtime\/Connections\.cs$/.test(f.filename)) return { ...f, content: connectionsCs(namespaceLine(f.content)) };
    if (/(^|\/)Runtime\/Schema\.cs$/.test(f.filename) && f.content.includes('public static class Schema')) return { ...f, content: schemaCs(namespaceLine(f.content)) };
    if (!/\.(cs|csproj)$/.test(f.filename)) return f;
    let content = f.content;
    if (CLAIM_BLOCK.test(content)) content = content.replace(CLAIM_BLOCK, () => CLAIM);
    for (const [pg, my] of STATEMENTS) content = content.split(pg).join(my);
    for (const [re, to] of TYPES) content = content.replace(re, to);
    if (f.filename.endsWith('.cs')) {
      // Commands outside Exec bind their parameters in order: $n -> ? in the text (Exec translates at run time).
      content = content.split('\n').map(line => (/\bExec\(/.test(line) ? line : line.replace(/\$(\d+)\b/g, '?'))).join('\n');
      content = content.replace(/(?<![.\w])now\(\)/g, 'CURRENT_TIMESTAMP(6)');
    }
    return { ...f, content };
  });
}

function namespaceLine(content: string): string {
  return content.match(/^namespace [\w.]+;\n/m)?.[0] ?? '';
}
