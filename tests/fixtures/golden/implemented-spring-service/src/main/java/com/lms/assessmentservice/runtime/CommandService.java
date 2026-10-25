package com.lms.assessmentservice.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.function.BiFunction;

/**
 * Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
 * logic, aggregate save and outbox insert. A domain error rolls back everything.
 */
public class CommandService {
    private static final String AGGREGATE_TYPE = "Grade";
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();
    private static final Map<String, BiFunction<GradeAggregate, GradeCommand, GradeDomainEvent>> COMMANDS = Map.of(
        "publish_grade", (a, c) -> a.publishGrade(c)
    );

    public record Request(String tenantId, String aggregateId, String command, Map<String, Object> payload, String idempotencyKey, String traceparent) {
        public Request(String tenantId, String aggregateId, String command) {
            this(tenantId, aggregateId, command, Map.of(), null, null);
        }
    }

    public record Result(String status, String aggregateId, String eventType, Long version) {}

    public record Snapshot(String state, long version) {}

    private final ConnectionFactory connections;
    private final String s;

    public CommandService(ConnectionFactory connections, String schema) {
        this.connections = connections;
        this.s = Schema.name(schema);
    }

    public Result handle(Request req) throws SQLException {
        if (req.tenantId() == null || req.tenantId().isBlank()) throw new DomainValidationException("tenantId is required");
        Context parent = Telemetry.contextFrom(req.traceparent());
        Span span = Telemetry.tracer().spanBuilder("Grade." + req.command()).setParent(parent).setSpanKind(SpanKind.INTERNAL)
            .setAttribute("tenant.id", req.tenantId()).setAttribute("aggregate.id", req.aggregateId()).startSpan();
        try (Connection conn = connections.open()) {
            conn.setAutoCommit(false);
            try {
                Result result = execute(conn, req, Telemetry.traceparentOf(parent, span));
                conn.commit();
                return result;
            } catch (SQLException | RuntimeException e) {
                conn.rollback();
                throw e;
            }
        } catch (SQLException | RuntimeException e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            span.end();
        }
    }

    private Result execute(Connection conn, Request req, String traceparent) throws SQLException {
        String key = req.idempotencyKey();
        if (key != null) {
            if (update(conn, "INSERT INTO " + s + ".ghk_idempotency (tenant_id, key, status) VALUES (?, ?, 'PROCESSING') ON CONFLICT DO NOTHING", req.tenantId(), key) == 0) {
                try (PreparedStatement ps = conn.prepareStatement("SELECT status, response FROM " + s + ".ghk_idempotency WHERE tenant_id = ? AND key = ?")) {
                    ps.setString(1, req.tenantId());
                    ps.setString(2, key);
                    try (ResultSet rs = ps.executeQuery()) {
                        if (rs.next() && "COMPLETED".equals(rs.getString(1))) {
                            Result stored = readJson(rs.getString(2));
                            return new Result("replayed", stored.aggregateId(), stored.eventType(), stored.version());
                        }
                    }
                }
                return new Result("in-progress", req.aggregateId(), null, null);
            }
        }
        GradeAggregate aggregate;
        try (PreparedStatement ps = conn.prepareStatement("SELECT state, version FROM " + s + ".ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ? FOR UPDATE")) {
            ps.setString(1, req.tenantId());
            ps.setString(2, AGGREGATE_TYPE);
            ps.setString(3, req.aggregateId());
            try (ResultSet rs = ps.executeQuery()) {
                aggregate = rs.next()
                    ? GradeAggregate.restore(req.aggregateId(), GradeState.valueOf(rs.getString(1)), rs.getLong(2))
                    : new GradeAggregate(req.aggregateId());
            }
        }
        var handler = COMMANDS.get(req.command());
        if (handler == null) throw new DomainValidationException("Unknown command " + req.command());
        GradeDomainEvent event = handler.apply(aggregate, new GradeCommand(req.aggregateId(), req.payload() == null ? Map.of() : req.payload()));
        update(conn, "INSERT INTO " + s + ".ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (?, ?, ?, ?, ?) "
            + "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
            req.tenantId(), AGGREGATE_TYPE, req.aggregateId(), aggregate.getState().name(), aggregate.getVersion());
        String eventType = event.type().name();
        update(conn, "INSERT INTO " + s + ".ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (?, ?, ?, ?, ?, ?)",
            UUID.randomUUID().toString(), req.tenantId(), req.aggregateId(), eventType, writeJson(event), traceparent);
        Result result = new Result("created", req.aggregateId(), eventType, event.version());
        if (key != null) {
            update(conn, "UPDATE " + s + ".ghk_idempotency SET status = 'COMPLETED', response = ? WHERE tenant_id = ? AND key = ?", writeJson(result), req.tenantId(), key);
        }
        return result;
    }

    /** The aggregate as tenantId sees it (empty for other tenants' aggregates). */
    public Optional<Snapshot> load(String tenantId, String aggregateId) throws SQLException {
        try (Connection conn = connections.open();
             PreparedStatement ps = conn.prepareStatement("SELECT state, version FROM " + s + ".ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ?")) {
            ps.setString(1, tenantId);
            ps.setString(2, AGGREGATE_TYPE);
            ps.setString(3, aggregateId);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? Optional.of(new Snapshot(rs.getString(1), rs.getLong(2))) : Optional.empty();
            }
        }
    }

    static int update(Connection conn, String sql, Object... args) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) ps.setObject(i + 1, args[i]);
            return ps.executeUpdate();
        }
    }

    private static String writeJson(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Result readJson(String value) {
        try {
            return JSON.readValue(value, Result.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
