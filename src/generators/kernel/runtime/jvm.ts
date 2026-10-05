/* ==========================================================================
   gherkin-ai-cli - Runtime kernel for the JVM (Spring Boot Java and Kotlin)
   JDBC + RabbitMQ amqp-client + OpenTelemetry Java, written in Java so both
   presets share it (Kotlin classes are called through Java interop).
   Contract: docs/RUNTIME-KERNEL.md.
   ========================================================================== */

import { DomainModel } from '../domain-model';
import { javaPackagePath } from '../java';
import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS, RLS_NOTE, RUNTIME_SCHEMA_SQL, SCHEMA_TOKEN, TEST_PARENT_SPAN_ID, TEST_TRACEPARENT, TEST_TRACE_ID, topology } from './shared';

export interface JvmRuntimeFile {
  filename: string;
  content: string;
}

const j = (s: string) => JSON.stringify(s); // JSON strings are valid Java string literals here

/** @param kotlin the domain kernel is Kotlin (data-class getters instead of record accessors) */
export function renderJvmRuntime(m: DomainModel, pkg: string, { kotlin = false } = {}): JvmRuntimeFile[] {
  const t = topology(m);
  const dir = `src/main/java/${javaPackagePath(pkg)}/runtime`;
  const testDir = `src/test/java/${javaPackagePath(pkg)}/runtime`;
  const p = `package ${pkg}.runtime;\n\n`;
  const A = `${m.pascal}Aggregate`;
  const ev = (field: string) => (kotlin ? `get${field[0].toUpperCase()}${field.slice(1)}()` : `${field}()`);
  const statements = RUNTIME_SCHEMA_SQL.map(s => `        ${j(s)}`).join(',\n');

  const connections = `${p}import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

/** Opens JDBC connections; replace with a pooled DataSource in production. */
@FunctionalInterface
public interface ConnectionFactory {
    Connection open() throws SQLException;

    /** From a libpq-style URL: postgres://user:password@host:5432/database */
    static ConnectionFactory fromUrl(String databaseUrl) {
        URI uri = URI.create(databaseUrl.replaceFirst("^postgres(ql)?://", "postgresql://"));
        String jdbc = "jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() > 0 ? uri.getPort() : 5432) + uri.getPath();
        String[] userInfo = uri.getRawUserInfo() == null ? new String[0] : uri.getRawUserInfo().split(":", 2);
        String user = userInfo.length > 0 ? URLDecoder.decode(userInfo[0], StandardCharsets.UTF_8) : null;
        String password = userInfo.length > 1 ? URLDecoder.decode(userInfo[1], StandardCharsets.UTF_8) : null;
        return () -> DriverManager.getConnection(jdbc, user, password);
    }
}
`;

  const schema = `${p}import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.regex.Pattern;

/** Runtime tables (docs/RUNTIME-KERNEL.md). */
public final class Schema {
    private static final Pattern NAME = Pattern.compile("[a-z_][a-z0-9_]*");
    private static final List<String> STATEMENTS = List.of(
${statements}
    );

${RLS_NOTE.split('\n').map(l => `    ${l.replace(/^-- ?/, '// ')}`).join('\n')}

    private Schema() {}

    public static String name(String schema) {
        String s = schema == null || schema.isEmpty() ? "public" : schema;
        if (!NAME.matcher(s).matches()) throw new IllegalArgumentException("Invalid schema name: " + s);
        return s;
    }

    public static void migrate(ConnectionFactory connections, String schema) throws SQLException {
        String s = name(schema);
        try (Connection conn = connections.open(); Statement st = conn.createStatement()) {
            for (String statement : STATEMENTS) st.execute(statement.replace(${j(SCHEMA_TOKEN)}, s));
        }
    }
}
`;

  const telemetry = `${p}import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import java.util.HashMap;
import java.util.Map;

/** W3C trace-context helpers; spans go to the global OpenTelemetry (configure exporters with OTEL_*). */
public final class Telemetry {
    private static final W3CTraceContextPropagator PROPAGATOR = W3CTraceContextPropagator.getInstance();
    private static final TextMapGetter<Map<String, String>> GETTER = new TextMapGetter<>() {
        @Override public Iterable<String> keys(Map<String, String> carrier) { return carrier.keySet(); }
        @Override public String get(Map<String, String> carrier, String key) { return carrier == null ? null : carrier.get(key); }
    };

    private Telemetry() {}

    public static Tracer tracer() {
        return GlobalOpenTelemetry.getTracer(${j(m.kebab)});
    }

    /** Context whose parent is the span described by an incoming traceparent header. */
    public static Context contextFrom(String traceparent) {
        if (traceparent == null || traceparent.isEmpty()) return Context.current();
        return PROPAGATOR.extract(Context.current(), Map.of("traceparent", traceparent), GETTER);
    }

    /** traceparent header value for a span in a context (null when the span is invalid). */
    public static String traceparentOf(Context parent, Span span) {
        Map<String, String> carrier = new HashMap<>();
        PROPAGATOR.inject(parent.with(span), carrier, Map::put);
        return carrier.get("traceparent");
    }
}
`;

  const commandService = `${p}import ${pkg}.domain.${A};
import ${pkg}.domain.${m.pascal}Command;
import ${pkg}.domain.${m.pascal}DomainEvent;
import ${pkg}.domain.${m.pascal}State;
import ${pkg}.domain.DomainValidationException;
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
    private static final String AGGREGATE_TYPE = ${j(m.pascal)};
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();
    private static final Map<String, BiFunction<${A}, ${m.pascal}Command, ${m.pascal}DomainEvent>> COMMANDS = Map.of(
${m.commands.map(c => `        ${j(c.snake)}, (a, c) -> a.${c.method}(c)`).join(',\n')}
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
        Span span = Telemetry.tracer().spanBuilder(${j(m.pascal + '.')} + req.command()).setParent(parent).setSpanKind(SpanKind.INTERNAL)
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
        ${A} aggregate;
        try (PreparedStatement ps = conn.prepareStatement("SELECT state, version FROM " + s + ".ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ? FOR UPDATE")) {
            ps.setString(1, req.tenantId());
            ps.setString(2, AGGREGATE_TYPE);
            ps.setString(3, req.aggregateId());
            try (ResultSet rs = ps.executeQuery()) {
                aggregate = rs.next()
                    ? ${A}.restore(req.aggregateId(), ${m.pascal}State.valueOf(rs.getString(1)), rs.getLong(2))
                    : new ${A}(req.aggregateId());
            }
        }
        var handler = COMMANDS.get(req.command());
        if (handler == null) throw new DomainValidationException("Unknown command " + req.command());
        ${m.pascal}DomainEvent event = handler.apply(aggregate, new ${m.pascal}Command(req.aggregateId(), req.payload() == null ? Map.of() : req.payload()));
        update(conn, "INSERT INTO " + s + ".ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (?, ?, ?, ?, ?) "
            + "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
            req.tenantId(), AGGREGATE_TYPE, req.aggregateId(), aggregate.getState().name(), aggregate.getVersion());
        String eventType = event.${ev('type')}.name();
        update(conn, "INSERT INTO " + s + ".ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (?, ?, ?, ?, ?, ?)",
            UUID.randomUUID().toString(), req.tenantId(), req.aggregateId(), eventType, writeJson(event), traceparent);
        Result result = new Result("created", req.aggregateId(), eventType, event.${ev('version')});
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
`;

  const topologyJava = `${p}import com.rabbitmq.client.Channel;
import java.io.IOException;
import java.util.Map;

/** Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ. */
public record Topology(String exchange, String queue, String dlx, String dlq) {
    public static final Topology DEFAULT = new Topology(${j(t.exchange)}, ${j(t.queue)}, ${j(t.dlx)}, ${j(t.dlq)});

    public static Topology forPrefix(String prefix) {
        return new Topology(prefix + ".events", prefix + ".consumer", prefix + ".dlx", prefix + ".dlq");
    }

    public void declare(Channel channel) throws IOException {
        channel.exchangeDeclare(exchange, "topic", true);
        channel.exchangeDeclare(dlx, "fanout", true);
        channel.queueDeclare(dlq, true, false, false, null);
        channel.queueBind(dlq, dlx, "");
        channel.queueDeclare(queue, true, false, false, Map.of("x-dead-letter-exchange", dlx));
        channel.queueBind(queue, exchange, "#");
    }
}
`;

  const relay = `${p}import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
 * concurrent relays never publish the same row; publisher confirms guarantee delivery to the broker
 * before a row is marked published. Use one relay (and channel) per thread.
 */
public class OutboxRelay {
    private final ConnectionFactory connections;
    private final Channel channel;
    private final String exchange;
    private final String s;
    private final int leaseSeconds;
    private final int maxAttempts;

    public OutboxRelay(ConnectionFactory connections, Channel channel, String exchange, String schema) throws java.io.IOException {
        this.connections = connections;
        this.channel = channel;
        this.exchange = exchange;
        this.s = Schema.name(schema);
        this.leaseSeconds = ${LEASE_SECONDS};
        this.maxAttempts = ${MAX_PUBLISH_ATTEMPTS};
        channel.confirmSelect();
    }

    private record Claimed(String id, String tenantId, String eventType, String payload, String traceparent) {}

    public int publishBatch(String workerId, int limit) throws Exception {
        List<Claimed> batch = new ArrayList<>();
        try (Connection conn = connections.open();
             PreparedStatement ps = conn.prepareStatement("UPDATE " + s + ".ghk_outbox SET claimed_by = ?, claimed_until = now() + make_interval(secs => ?), attempts = attempts + 1 "
                 + "WHERE id IN (SELECT id FROM " + s + ".ghk_outbox WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now()) "
                 + "ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED) RETURNING id, tenant_id, event_type, payload, traceparent")) {
            ps.setString(1, workerId);
            ps.setInt(2, leaseSeconds);
            ps.setInt(3, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) batch.add(new Claimed(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)));
            }
        }
        int published = 0;
        try (Connection conn = connections.open()) {
            for (Claimed row : batch) {
                Context parent = Telemetry.contextFrom(row.traceparent());
                Span span = Telemetry.tracer().spanBuilder(exchange + " publish").setParent(parent).setSpanKind(SpanKind.PRODUCER)
                    .setAttribute("messaging.system", "rabbitmq").setAttribute("messaging.destination.name", exchange)
                    .setAttribute("messaging.message.id", row.id()).setAttribute("tenant.id", row.tenantId()).startSpan();
                try {
                    Map<String, Object> headers = new HashMap<>();
                    headers.put("tenant_id", row.tenantId());
                    String traceparent = Telemetry.traceparentOf(parent, span);
                    if (traceparent != null) headers.put("traceparent", traceparent);
                    AMQP.BasicProperties props = new AMQP.BasicProperties.Builder()
                        .messageId(row.id()).deliveryMode(2).contentType("application/json").type(row.eventType()).headers(headers).build();
                    channel.basicPublish(exchange, row.eventType(), props, row.payload().getBytes(StandardCharsets.UTF_8));
                    channel.waitForConfirmsOrDie(10_000);
                    CommandService.update(conn, "UPDATE " + s + ".ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = ? AND claimed_by = ?", row.id(), workerId);
                    published++;
                } catch (Exception e) {
                    span.recordException(e);
                    span.setStatus(StatusCode.ERROR);
                    CommandService.update(conn, "UPDATE " + s + ".ghk_outbox SET claimed_until = NULL, last_error = ?, failed_at = CASE WHEN attempts >= ? THEN now() ELSE NULL END WHERE id = ?",
                        String.valueOf(e.getMessage()), maxAttempts, row.id());
                } finally {
                    span.end();
                }
            }
        }
        return published;
    }
}
`;

  const inbox = `${p}import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.GetResponse;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import java.sql.Connection;
import java.util.Map;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
 */
public class InboxConsumer {
    public record Meta(String messageId, String tenantId, String eventType, Connection connection) {}

    @FunctionalInterface
    public interface Handler {
        void handle(Map<String, Object> event, Meta meta) throws Exception;
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private final ConnectionFactory connections;
    private final Channel channel;
    private final String queue;
    private final String consumerName;
    private final Handler handler;
    private final String s;

    public InboxConsumer(ConnectionFactory connections, Channel channel, String queue, String consumerName, Handler handler, String schema) {
        this.connections = connections;
        this.channel = channel;
        this.queue = queue;
        this.consumerName = consumerName;
        this.handler = handler;
        this.s = Schema.name(schema);
    }

    /** Processes messages until the queue stays empty for idleMillis; returns how many were processed. */
    public int drain(long idleMillis) throws Exception {
        int processed = 0;
        long idleSince = System.currentTimeMillis();
        while (System.currentTimeMillis() - idleSince < idleMillis) {
            GetResponse response = channel.basicGet(queue, false);
            if (response == null) {
                Thread.sleep(50);
                continue;
            }
            process(response);
            processed++;
            idleSince = System.currentTimeMillis();
        }
        return processed;
    }

    @SuppressWarnings("unchecked")
    private void process(GetResponse response) throws Exception {
        var props = response.getProps();
        Map<String, Object> headers = props.getHeaders() == null ? Map.of() : props.getHeaders();
        Object traceparent = headers.get("traceparent");
        Span span = Telemetry.tracer().spanBuilder(queue + " process")
            .setParent(Telemetry.contextFrom(traceparent == null ? null : traceparent.toString())).setSpanKind(SpanKind.CONSUMER)
            .setAttribute("messaging.system", "rabbitmq").setAttribute("messaging.destination.name", queue)
            .setAttribute("messaging.message.id", String.valueOf(props.getMessageId())).startSpan();
        long tag = response.getEnvelope().getDeliveryTag();
        try (Connection conn = connections.open()) {
            conn.setAutoCommit(false);
            try {
                if (CommandService.update(conn, "INSERT INTO " + s + ".ghk_inbox (consumer, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING", consumerName, props.getMessageId()) == 1) {
                    Object tenant = headers.get("tenant_id");
                    handler.handle(JSON.readValue(response.getBody(), Map.class),
                        new Meta(props.getMessageId(), tenant == null ? null : tenant.toString(), props.getType(), conn));
                }
                conn.commit();
                channel.basicAck(tag, false);
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR);
            channel.basicNack(tag, false, false);
        } finally {
            span.end();
        }
    }
}
`;

  const saga = `${p}import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
 * are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
public class SagaOrchestrator {
    @FunctionalInterface
    public interface Action {
        void run() throws Exception;
    }

    public record Step(String name, Action action, Action compensate) {}

    public record Status(String status, List<String> completedSteps) {}

    private final ConnectionFactory connections;
    private final String s;

    public SagaOrchestrator(ConnectionFactory connections, String schema) {
        this.connections = connections;
        this.s = Schema.name(schema);
    }

    public String run(String sagaId, String tenantId, List<Step> steps) throws Exception {
        try (Connection conn = connections.open()) {
            CommandService.update(conn, "INSERT INTO " + s + ".ghk_sagas (id, tenant_id, status) VALUES (?, ?, 'RUNNING') ON CONFLICT (id) DO NOTHING", sagaId, tenantId);
            List<String> completed = new ArrayList<>(read(conn, sagaId).map(Status::completedSteps).orElse(List.of()));
            for (Step step : steps) {
                if (completed.contains(step.name())) continue;
                try {
                    step.action().run();
                } catch (Exception failure) {
                    save(conn, sagaId, "COMPENSATING", completed);
                    for (int i = completed.size() - 1; i >= 0; i--) {
                        String name = completed.get(i);
                        steps.stream().filter(x -> x.name().equals(name)).findFirst().orElseThrow().compensate().run();
                        completed.remove(i);
                        save(conn, sagaId, "COMPENSATING", completed);
                    }
                    save(conn, sagaId, "COMPENSATED", completed);
                    return "COMPENSATED";
                }
                completed.add(step.name());
                save(conn, sagaId, "RUNNING", completed);
            }
            save(conn, sagaId, "COMPLETED", completed);
            return "COMPLETED";
        }
    }

    public Optional<Status> status(String sagaId) throws SQLException {
        try (Connection conn = connections.open()) {
            return read(conn, sagaId);
        }
    }

    private Optional<Status> read(Connection conn, String sagaId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("SELECT status, completed_steps FROM " + s + ".ghk_sagas WHERE id = ?")) {
            ps.setString(1, sagaId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return Optional.empty();
                String done = rs.getString(2);
                return Optional.of(new Status(rs.getString(1), done == null || done.isEmpty() ? List.of() : Arrays.asList(done.split(","))));
            }
        }
    }

    private void save(Connection conn, String sagaId, String status, List<String> completed) throws SQLException {
        CommandService.update(conn, "UPDATE " + s + ".ghk_sagas SET status = ?, completed_steps = ?, updated_at = now() WHERE id = ?", status, String.join(",", completed), sagaId);
    }
}
`;

  const first = m.commands[0];
  const test = `${p}import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ${pkg}.domain.DomainValidationException;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.GetResponse;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and AMQP_URL. */
@Tag("integration")
class RuntimeIntegrationTest {
    private static final String COMMAND = ${j(first.snake)};
    private static final String EVENT = ${j(first.event)};
    private static final InMemorySpanExporter EXPORTER = InMemorySpanExporter.create();
    private static ConnectionFactory connections;
    private static com.rabbitmq.client.Connection amqp;
    private String schema;
    private Topology topology;

    @BeforeAll
    static void connect() throws Exception {
        String dbUrl = System.getenv("DATABASE_URL");
        String amqpUrl = System.getenv("AMQP_URL");
        if (dbUrl == null || amqpUrl == null) throw new IllegalStateException("Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).");
        GlobalOpenTelemetry.resetForTest();
        OpenTelemetrySdk.builder().setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(EXPORTER)).build()).buildAndRegisterGlobal();
        connections = ConnectionFactory.fromUrl(dbUrl);
        var factory = new com.rabbitmq.client.ConnectionFactory();
        factory.setUri(amqpUrl);
        factory.setConnectionTimeout(30_000);
        factory.setHandshakeTimeout(30_000);
        // A busy CI host can delay the AMQP handshake: retry before failing the suite.
        for (int attempt = 1; ; attempt++) {
            try {
                amqp = factory.newConnection();
                break;
            } catch (java.io.IOException | java.util.concurrent.TimeoutException e) {
                if (attempt == 5) throw e;
                Thread.sleep(2000L * attempt);
            }
        }
    }

    @BeforeEach
    void freshSchema() throws Exception {
        String uid = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        schema = "it_" + uid;
        topology = Topology.forPrefix("it-" + uid);
        Schema.migrate(connections, schema);
        EXPORTER.reset();
    }

    @AfterEach
    void dropSchema() throws Exception {
        try (Connection conn = connections.open(); Statement st = conn.createStatement()) {
            st.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private int count(String table, String where, Object... args) throws Exception {
        try (Connection conn = connections.open(); PreparedStatement ps = conn.prepareStatement("SELECT count(*) FROM " + schema + "." + table + " WHERE " + where)) {
            for (int i = 0; i < args.length; i++) ps.setObject(i + 1, args[i]);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private static List<GetResponse> drainQueue(Channel channel, String queue) throws Exception {
        List<GetResponse> out = new ArrayList<>();
        for (GetResponse r = channel.basicGet(queue, true); r != null; r = channel.basicGet(queue, true)) out.add(r);
        return out;
    }

    private static void waitFor(Callable<Boolean> check) throws Exception {
        long deadline = System.currentTimeMillis() + 10_000;
        while (!check.call()) {
            if (System.currentTimeMillis() > deadline) throw new AssertionError("timed out waiting for condition");
            Thread.sleep(50);
        }
    }

    @Test
    void it1AtomicWriteAndRollback() throws Exception {
        var service = new CommandService(connections, schema);
        var result = service.handle(new CommandService.Request("t1", "agg-1", COMMAND));
        assertEquals("created", result.status());
        assertEquals(EVENT, result.eventType());
        assertEquals(1L, result.version());
        assertEquals(1L, service.load("t1", "agg-1").orElseThrow().version());
        assertEquals(1, count("ghk_outbox", "aggregate_id = ?", "agg-1"));

        var failure = assertThrows(DomainValidationException.class,
            () -> service.handle(new CommandService.Request("t1", "agg-2", "no_such_command", Map.of(), "k-fail", null)));
        assertTrue(failure.getMessage().contains("Unknown command"));
        assertTrue(service.load("t1", "agg-2").isEmpty());
        assertEquals(0, count("ghk_outbox", "aggregate_id = ?", "agg-2"));
        assertEquals(0, count("ghk_idempotency", "key = ?", "k-fail"));
    }

    @Test
    void it2ConcurrentIdempotentRequests() throws Exception {
        var service = new CommandService(connections, schema);
        ExecutorService pool = Executors.newFixedThreadPool(5);
        List<Future<CommandService.Result>> futures = new ArrayList<>();
        for (int i = 0; i < 5; i++) futures.add(pool.submit(() -> service.handle(new CommandService.Request("t1", "agg-1", COMMAND, Map.of(), "key-1", null))));
        List<CommandService.Result> results = new ArrayList<>();
        for (var f : futures) results.add(f.get());
        pool.shutdown();
        assertEquals(1, count("ghk_outbox", "true"));
        assertEquals(1L, service.load("t1", "agg-1").orElseThrow().version());
        assertEquals(1, results.stream().filter(r -> r.status().equals("created")).count());
        for (var r : results) {
            assertEquals(EVENT, r.eventType());
            assertEquals(1L, r.version());
        }
    }

    @Test
    void it3ConcurrentRelaysPublishExactlyOnce() throws Exception {
        var service = new CommandService(connections, schema);
        for (int i = 0; i < 20; i++) service.handle(new CommandService.Request("t1", "agg-" + i, COMMAND));
        Channel setup = amqp.createChannel();
        topology.declare(setup);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Future<Integer>> totals = new ArrayList<>();
        for (String worker : List.of("relay-a", "relay-b")) {
            totals.add(pool.submit(() -> {
                var relay = new OutboxRelay(connections, amqp.createChannel(), topology.exchange(), schema);
                int total = 0;
                for (int n = relay.publishBatch(worker, 3); n > 0; n = relay.publishBatch(worker, 3)) total += n;
                return total;
            }));
        }
        int published = 0;
        for (var t : totals) published += t.get();
        pool.shutdown();
        assertEquals(20, published);
        assertEquals(0, count("ghk_outbox", "published_at IS NULL"));
        waitFor(() -> setup.queueDeclarePassive(topology.queue()).getMessageCount() == 20);
        Set<String> ids = new HashSet<>();
        for (GetResponse r : drainQueue(setup, topology.queue())) ids.add(r.getProps().getMessageId());
        assertEquals(20, ids.size());
        setup.close();
    }

    @Test
    void it4TenantIsolation() throws Exception {
        var service = new CommandService(connections, schema);
        service.handle(new CommandService.Request("tenant-a", "shared-id", COMMAND));
        assertTrue(service.load("tenant-b", "shared-id").isEmpty());
        service.handle(new CommandService.Request("tenant-b", "shared-id", COMMAND));
        assertEquals(1L, service.load("tenant-a", "shared-id").orElseThrow().version());
        assertEquals(1L, service.load("tenant-b", "shared-id").orElseThrow().version());
        assertEquals(1, count("ghk_outbox", "tenant_id = ?", "tenant-a"));
    }

    @Test
    void it5SagaCompensatesInReverseOrder() throws Exception {
        var saga = new SagaOrchestrator(connections, schema);
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        java.util.function.BiFunction<String, Boolean, SagaOrchestrator.Step> step = (name, fail) -> new SagaOrchestrator.Step(name,
            () -> { if (fail) throw new IllegalStateException(name + " failed"); log.add("do:" + name); },
            () -> log.add("undo:" + name));
        assertEquals("COMPENSATED", saga.run("saga-1", "t1", List.of(step.apply("reserve", false), step.apply("charge", false), step.apply("ship", true))));
        assertEquals(List.of("do:reserve", "do:charge", "undo:charge", "undo:reserve"), log);
        var status = saga.status("saga-1").orElseThrow();
        assertEquals("COMPENSATED", status.status());
        assertTrue(status.completedSteps().isEmpty());
        assertEquals("COMPLETED", saga.run("saga-2", "t1", List.of(step.apply("reserve", false), step.apply("charge", false))));
    }

    @Test
    void it6InboxDeduplicatesAndDeadLetters() throws Exception {
        Channel channel = amqp.createChannel();
        topology.declare(channel);
        List<String> handled = new ArrayList<>();
        var consumer = new InboxConsumer(connections, channel, topology.queue(), "it-consumer", (event, meta) -> {
            if (Boolean.TRUE.equals(event.get("poison"))) throw new IllegalStateException("cannot process");
            handled.add(meta.messageId());
        }, schema);
        for (String[] m : new String[][] {{"m-1", "{\\"ok\\": true}"}, {"m-1", "{\\"ok\\": true}"}, {"m-poison", "{\\"poison\\": true}"}}) {
            var props = new com.rabbitmq.client.AMQP.BasicProperties.Builder().messageId(m[0]).headers(Map.of("tenant_id", "t1")).build();
            channel.basicPublish(topology.exchange(), "Test", props, m[1].getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        consumer.drain(1000);
        assertEquals(List.of("m-1"), handled);
        assertEquals(1, count("ghk_inbox", "consumer = ?", "it-consumer"));
        waitFor(() -> channel.queueDeclarePassive(topology.dlq()).getMessageCount() == 1);
        var dead = drainQueue(channel, topology.dlq());
        assertEquals(1, dead.size());
        assertEquals("m-poison", dead.get(0).getProps().getMessageId());
        channel.close();
    }

    @Test
    void it7TraceContextPropagation() throws Exception {
        var service = new CommandService(connections, schema);
        service.handle(new CommandService.Request("t1", "agg-1", COMMAND, Map.of(), null, ${j(TEST_TRACEPARENT)}));
        try (Connection conn = connections.open(); Statement st = conn.createStatement(); ResultSet rs = st.executeQuery("SELECT traceparent FROM " + schema + ".ghk_outbox")) {
            rs.next();
            assertTrue(rs.getString(1).contains(${j(TEST_TRACE_ID)}));
        }
        Channel channel = amqp.createChannel();
        topology.declare(channel);
        assertEquals(1, new OutboxRelay(connections, channel, topology.exchange(), schema).publishBatch("relay", 10));
        List<String> received = new ArrayList<>();
        new InboxConsumer(connections, amqp.createChannel(), topology.queue(), "trace-consumer", (event, meta) -> received.add(meta.messageId()), schema).drain(1000);
        assertEquals(1, received.size());

        SpanData command = null, producer = null, consumer = null;
        for (SpanData span : EXPORTER.getFinishedSpanItems()) {
            if (span.getKind() == SpanKind.INTERNAL) command = span;
            if (span.getKind() == SpanKind.PRODUCER) producer = span;
            if (span.getKind() == SpanKind.CONSUMER) consumer = span;
        }
        assertEquals(${j(TEST_TRACE_ID)}, command.getTraceId());
        assertEquals(${j(TEST_PARENT_SPAN_ID)}, command.getParentSpanId());
        assertEquals(${j(TEST_TRACE_ID)}, producer.getTraceId());
        assertEquals(${j(TEST_TRACE_ID)}, consumer.getTraceId());
        assertEquals(producer.getSpanId(), consumer.getParentSpanId());
        channel.close();
    }
}
`;

  return [
    { filename: `${dir}/ConnectionFactory.java`, content: connections },
    { filename: `${dir}/Schema.java`, content: schema },
    { filename: `${dir}/Telemetry.java`, content: telemetry },
    { filename: `${dir}/CommandService.java`, content: commandService },
    { filename: `${dir}/Topology.java`, content: topologyJava },
    { filename: `${dir}/OutboxRelay.java`, content: relay },
    { filename: `${dir}/InboxConsumer.java`, content: inbox },
    { filename: `${dir}/SagaOrchestrator.java`, content: saga },
    { filename: `${testDir}/RuntimeIntegrationTest.java`, content: test }
  ];
}
