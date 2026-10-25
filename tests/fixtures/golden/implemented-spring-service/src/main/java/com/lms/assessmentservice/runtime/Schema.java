package com.lms.assessmentservice.runtime;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.regex.Pattern;

/** Runtime tables (docs/RUNTIME-KERNEL.md). */
public final class Schema {
    private static final Pattern NAME = Pattern.compile("[a-z_][a-z0-9_]*");
    private static final List<String> STATEMENTS = List.of(
        "CREATE SCHEMA IF NOT EXISTS __SCHEMA__",
        "CREATE TABLE IF NOT EXISTS __SCHEMA__.ghk_aggregates (tenant_id TEXT NOT NULL, aggregate_type TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, version INT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, aggregate_type, id))",
        "CREATE TABLE IF NOT EXISTS __SCHEMA__.ghk_outbox (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, traceparent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), claimed_by TEXT, claimed_until TIMESTAMPTZ, published_at TIMESTAMPTZ, attempts INT NOT NULL DEFAULT 0, last_error TEXT, failed_at TIMESTAMPTZ)",
        "CREATE INDEX IF NOT EXISTS ghk_outbox_pending ON __SCHEMA__.ghk_outbox (created_at) WHERE published_at IS NULL AND failed_at IS NULL",
        "CREATE TABLE IF NOT EXISTS __SCHEMA__.ghk_idempotency (tenant_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, key))",
        "CREATE TABLE IF NOT EXISTS __SCHEMA__.ghk_inbox (consumer TEXT NOT NULL, message_id TEXT NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (consumer, message_id))",
        "CREATE TABLE IF NOT EXISTS __SCHEMA__.ghk_sagas (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, completed_steps TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );

    // Defense in depth (optional): enforce tenant isolation in PostgreSQL as well.
    // ALTER TABLE ghk_aggregates ENABLE ROW LEVEL SECURITY;
    // CREATE POLICY tenant_isolation ON ghk_aggregates USING (tenant_id = current_setting('app.tenant_id'));
    // and run SET LOCAL app.tenant_id = '<tenant>' at the start of each transaction.

    private Schema() {}

    public static String name(String schema) {
        String s = schema == null || schema.isEmpty() ? "public" : schema;
        if (!NAME.matcher(s).matches()) throw new IllegalArgumentException("Invalid schema name: " + s);
        return s;
    }

    public static void migrate(ConnectionFactory connections, String schema) throws SQLException {
        String s = name(schema);
        try (Connection conn = connections.open(); Statement st = conn.createStatement()) {
            for (String statement : STATEMENTS) st.execute(statement.replace("__SCHEMA__", s));
        }
    }
}
