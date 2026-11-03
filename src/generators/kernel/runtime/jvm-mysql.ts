/* ==========================================================================
   gherkin-ai-cli - JVM runtime kernel on MySQL 8 (stack.kernelDatabase
   "mysql"; PLAN-3.3.0 X-01b). Spring Boot and Quarkus, Java and Kotlin.

   Same approach as the TypeScript kernel (typescript-mysql.ts): the
   PostgreSQL kernel is generated, then adapted:
     - DDL for MySQL; a schema is a MySQL database (the tests use one per
       test); migrations serialized with GET_LOCK;
     - ON CONFLICT DO NOTHING -> INSERT IGNORE; the aggregate upsert ->
       ON DUPLICATE KEY UPDATE; `key` quoted; now() -> CURRENT_TIMESTAMP(6);
     - the outbox claim (UPDATE ... RETURNING does not exist in MySQL):
       SELECT ... FOR UPDATE SKIP LOCKED, UPDATE the lease, read back, in
       one transaction;
     - the JDBC driver (mysql-connector-j, quarkus-jdbc-mysql) and Quarkus
       db-kind. ConnectionFactory already maps mysql:// URLs.
   Tenant isolation is the repository filter (tenant_id in every query):
   MySQL has no row-level security.
   ========================================================================== */

import { MYSQL_RUNTIME_TABLES, MYSQL_SCHEMA_TOKEN } from './typescript-mysql';

type File = { filename: string; content: string };

const j = (s: string) => JSON.stringify(s);

function schemaJava(pkg: string): string {
  return `${pkg}import java.net.URI;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.regex.Pattern;

/** Runtime tables on MySQL 8 (docs/RUNTIME-KERNEL.md): a schema is a MySQL database. */
public final class Schema {
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_$-]{1,64}");
    private static final List<String> STATEMENTS = List.of(
${MYSQL_RUNTIME_TABLES.map(s => `        ${j(s)}`).join(',\n')}
    );

    private Schema() {}

    /** The database of DATABASE_URL (the service's own). */
    public static String defaultSchema() {
        String url = System.getenv("DATABASE_URL");
        try {
            String path = url == null ? "" : URI.create(url).getPath();
            return path == null || path.length() <= 1 ? "app" : path.substring(1);
        } catch (IllegalArgumentException e) {
            return "app";
        }
    }

    private static String plain(String schema) {
        return schema == null || schema.isEmpty() || "public".equals(schema) ? defaultSchema() : schema;
    }

    /** Validated, quoted database name. */
    public static String name(String schema) {
        String s = plain(schema);
        if (!NAME.matcher(s).matches()) throw new IllegalArgumentException("Invalid schema name: " + s);
        return "\`" + s + "\`";
    }

    /**
     * Creates the runtime tables (idempotent); replicas starting together are serialized with a named lock.
     * Another database than DATABASE_URL's (tests) is created first; the service's own is never created here,
     * so its user needs no global CREATE privilege.
     */
    public static void migrate(ConnectionFactory connections, String schema) throws SQLException {
        String s = name(schema);
        try (Connection conn = connections.open(); Statement st = conn.createStatement()) {
            st.executeQuery("SELECT GET_LOCK('ghk_runtime_schema', 60)").close();
            try {
                if (!plain(schema).equals(defaultSchema())) st.execute("CREATE DATABASE IF NOT EXISTS " + s);
                for (String statement : STATEMENTS) st.execute(statement.replace(${j(MYSQL_SCHEMA_TOKEN)}, s));
            } finally {
                st.executeQuery("SELECT RELEASE_LOCK('ghk_runtime_schema')").close();
            }
        }
    }
}
`;
}

/** The outbox claim in one transaction: MySQL's UPDATE returns no rows. */
const CLAIM = `try (Connection conn = connections.open()) {
            // MySQL has no UPDATE ... RETURNING: lock the next batch (SKIP LOCKED), lease it and read it back.
            conn.setAutoCommit(false);
            try {
                List<String> due = new ArrayList<>();
                try (PreparedStatement ps = conn.prepareStatement("SELECT id FROM " + s + ".ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL "
                        + "AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP(6)) ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED")) {
                    ps.setInt(1, limit);
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) due.add(rs.getString(1));
                    }
                }
                if (!due.isEmpty()) {
                    String ids = String.join(", ", java.util.Collections.nCopies(due.size(), "?"));
                    try (PreparedStatement ps = conn.prepareStatement("UPDATE " + s + ".ghk_outbox SET claimed_by = ?, claimed_until = CURRENT_TIMESTAMP(6) + INTERVAL ? SECOND, "
                            + "attempts = attempts + 1 WHERE id IN (" + ids + ")")) {
                        ps.setString(1, workerId);
                        ps.setInt(2, leaseSeconds);
                        for (int i = 0; i < due.size(); i++) ps.setString(i + 3, due.get(i));
                        ps.executeUpdate();
                    }
                    try (PreparedStatement ps = conn.prepareStatement("SELECT id, tenant_id, event_type, payload, traceparent FROM " + s + ".ghk_outbox WHERE id IN (" + ids + ") ORDER BY created_at")) {
                        for (int i = 0; i < due.size(); i++) ps.setString(i + 1, due.get(i));
                        try (ResultSet rs = ps.executeQuery()) {
                            while (rs.next()) batch.add(new Claimed(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)));
                        }
                    }
                }
                conn.commit();
            } catch (java.sql.SQLException e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(true);
            }
        }
        int published = 0;`;

/** [PostgreSQL text, MySQL text] pairs as they appear in the generated Java sources. */
const STATEMENTS: [string, string][] = [
  [`"INSERT INTO " + s + ".ghk_idempotency (tenant_id, key, status) VALUES (?, ?, 'PROCESSING') ON CONFLICT DO NOTHING"`,
    `"INSERT IGNORE INTO " + s + ".ghk_idempotency (tenant_id, \`key\`, status) VALUES (?, ?, 'PROCESSING')"`],
  [`ghk_idempotency WHERE tenant_id = ? AND key = ?`, `ghk_idempotency WHERE tenant_id = ? AND \`key\` = ?`],
  [`WHERE tenant_id = ? AND key = ?", writeJson(result)`, `WHERE tenant_id = ? AND \`key\` = ?", writeJson(result)`],
  [`"ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()"`,
    `"AS incoming ON DUPLICATE KEY UPDATE state = incoming.state, version = incoming.version, updated_at = CURRENT_TIMESTAMP(6)"`],
  [`"INSERT INTO " + s + ".ghk_inbox (consumer, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING"`,
    `"INSERT IGNORE INTO " + s + ".ghk_inbox (consumer, message_id) VALUES (?, ?)"`],
  [`"INSERT INTO " + s + ".ghk_sagas (id, tenant_id, status) VALUES (?, ?, 'RUNNING') ON CONFLICT (id) DO NOTHING"`,
    `"INSERT IGNORE INTO " + s + ".ghk_sagas (id, tenant_id, status) VALUES (?, ?, 'RUNNING')"`],
  // Runtime integration tests: a schema is a database.
  [`"DROP SCHEMA IF EXISTS " + schema + " CASCADE"`, `"DROP DATABASE IF EXISTS " + schema`],
  [`count("ghk_idempotency", "key = ?"`, `count("ghk_idempotency", "\`key\` = ?"`],
  // Build files and configuration.
  ['<groupId>org.postgresql</groupId>\n      <artifactId>postgresql</artifactId>', '<groupId>com.mysql</groupId>\n      <artifactId>mysql-connector-j</artifactId>'],
  ['quarkus-jdbc-postgresql', 'quarkus-jdbc-mysql'],
  ['runtimeOnly("org.postgresql:postgresql")', 'runtimeOnly("com.mysql:mysql-connector-j")'],
  ['quarkus.datasource.db-kind=postgresql', 'quarkus.datasource.db-kind=mysql']
];

const CLAIM_BLOCK = /try \(Connection conn = connections\.open\(\);\s*PreparedStatement ps = conn\.prepareStatement\("UPDATE " \+ s \+ "\.ghk_outbox SET claimed_by[\s\S]*?\n {8}\}\n {8}int published = 0;/;

/** Adapts a generated Spring Boot / Quarkus project (PostgreSQL kernel) to MySQL. */
export function mysqlizeJvmProject(files: File[]): File[] {
  return files.map(f => {
    if (/(^|\/)Schema\.java$/.test(f.filename) && f.content.includes('public final class Schema')) {
      const pkg = f.content.match(/^package [\w.]+;\n\n/)?.[0] ?? '';
      return { ...f, content: schemaJava(pkg) };
    }
    if (!/\.(java|kt|xml|kts|properties|md)$/.test(f.filename)) return f;
    let content = f.content;
    for (const [pg, my] of STATEMENTS) content = content.split(pg).join(my);
    if (CLAIM_BLOCK.test(content)) content = content.replace(CLAIM_BLOCK, () => CLAIM);
    // now() in SQL strings (not Instant.now() / LocalDateTime.now()).
    if (/\.(java|kt)$/.test(f.filename)) content = content.replace(/(?<![.\w])now\(\)/g, 'CURRENT_TIMESTAMP(6)');
    return { ...f, content };
  });
}
