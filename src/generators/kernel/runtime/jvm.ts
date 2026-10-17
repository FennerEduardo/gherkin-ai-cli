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

/** Broker the generated runtime defaults to for a stack.messaging value (GHK_BROKER overrides it at run time). */
export function defaultJvmBroker(messaging?: string): 'rabbitmq' | 'pubsub' | 'servicebus' {
  if (/pubsub|pub-sub/i.test(messaging || '')) return 'pubsub';
  if (usesServiceBus(messaging)) return 'servicebus';
  return 'rabbitmq';
}

/** The Service Bus adapter brings the Azure SDK, so it is generated only for stack.messaging "servicebus". */
export function usesServiceBus(messaging?: string): boolean {
  return /service-?bus|azure-servicebus/i.test(messaging || '');
}

/** @param kotlin the domain kernel is Kotlin (data-class getters instead of record accessors) */
export function renderJvmRuntime(m: DomainModel, pkg: string, { kotlin = false, siblings = [] as DomainModel[], messaging = undefined as string | undefined } = {}): JvmRuntimeFile[] {
  const defaultBroker = defaultJvmBroker(messaging);
  const serviceBus = usesServiceBus(messaging);
  const all = [m, ...siblings];
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
    // keys() is a deprecated default since OpenTelemetry 1.67; W3C extraction only needs get().
    private static final TextMapGetter<Map<String, String>> GETTER = (carrier, key) -> carrier == null ? null : carrier.get(key);

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

  const commandService = `${p}${all.map(a => `import ${pkg}.domain.${a.pascal}Aggregate;\nimport ${pkg}.domain.${a.pascal}Command;\nimport ${pkg}.domain.${a.pascal}DomainEvent;\nimport ${pkg}.domain.${a.pascal}State;`).join('\n')}
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

/**
 * Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE), domain
 * logic, aggregate save and outbox insert. A domain error rolls back everything.
 */
public class CommandService {
    /** Aggregate type used when a request does not name one. */
    public static final String DEFAULT_AGGREGATE = ${j(m.pascal)};
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();

    /** aggregateType: the feature's aggregate (e.g. ${j(m.pascal)}); null means DEFAULT_AGGREGATE. */
    public record Request(String tenantId, String aggregateId, String command, Map<String, Object> payload, String idempotencyKey, String traceparent, String aggregateType) {
        public Request(String tenantId, String aggregateId, String command, Map<String, Object> payload, String idempotencyKey, String traceparent) {
            this(tenantId, aggregateId, command, payload, idempotencyKey, traceparent, null);
        }

        public Request(String tenantId, String aggregateId, String command) {
            this(tenantId, aggregateId, command, Map.of(), null, null, null);
        }

        String type() {
            return aggregateType == null || aggregateType.isBlank() ? DEFAULT_AGGREGATE : aggregateType;
        }
    }

    /** The result of running a command on an aggregate: its new state and the recorded event. */
    private record Applied(String state, long version, String eventType, long eventVersion, Object event) {}

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
        String type = req.type();
        String state = null;
        long version = 0;
        try (PreparedStatement ps = conn.prepareStatement("SELECT state, version FROM " + s + ".ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ? FOR UPDATE")) {
            ps.setString(1, req.tenantId());
            ps.setString(2, type);
            ps.setString(3, req.aggregateId());
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    state = rs.getString(1);
                    version = rs.getLong(2);
                }
            }
        }
        Map<String, Object> payload = req.payload() == null ? Map.of() : req.payload();
        Applied applied = switch (type) {
${all.map(a => `            case ${j(a.pascal)} -> apply${a.pascal}(req.aggregateId(), state, version, req.command(), payload);`).join('\n')}
            default -> throw new DomainValidationException("Unknown aggregate type " + type);
        };
        update(conn, "INSERT INTO " + s + ".ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES (?, ?, ?, ?, ?) "
            + "ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()",
            req.tenantId(), type, req.aggregateId(), applied.state(), applied.version());
        update(conn, "INSERT INTO " + s + ".ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (?, ?, ?, ?, ?, ?)",
            UUID.randomUUID().toString(), req.tenantId(), req.aggregateId(), applied.eventType(), writeJson(applied.event()), traceparent);
        Result result = new Result("created", req.aggregateId(), applied.eventType(), applied.eventVersion());
        if (key != null) {
            update(conn, "UPDATE " + s + ".ghk_idempotency SET status = 'COMPLETED', response = ? WHERE tenant_id = ? AND key = ?", writeJson(result), req.tenantId(), key);
        }
        return result;
    }

${all.map(a => `    private static Applied apply${a.pascal}(String id, String state, long version, String command, Map<String, Object> payload) {
        ${a.pascal}Aggregate aggregate = state == null ? new ${a.pascal}Aggregate(id) : ${a.pascal}Aggregate.restore(id, ${a.pascal}State.valueOf(state), version);
        ${a.pascal}Command cmd = new ${a.pascal}Command(id, payload);
        ${a.pascal}DomainEvent event = switch (command) {
${a.commands.map(c => `            case ${j(c.snake)} -> aggregate.${c.method}(cmd);`).join('\n')}
            default -> throw new DomainValidationException("Unknown command " + command);
        };
        return new Applied(aggregate.getState().name(), aggregate.getVersion(), event.${ev('type')}.name(), event.${ev('version')}, event);
    }
`).join('\n')}
    /** The aggregate as tenantId sees it (empty for other tenants' aggregates). */
    public Optional<Snapshot> load(String tenantId, String aggregateId) throws SQLException {
        return load(tenantId, aggregateId, DEFAULT_AGGREGATE);
    }

    public Optional<Snapshot> load(String tenantId, String aggregateId, String aggregateType) throws SQLException {
        try (Connection conn = connections.open();
             PreparedStatement ps = conn.prepareStatement("SELECT state, version FROM " + s + ".ghk_aggregates WHERE tenant_id = ? AND aggregate_type = ? AND id = ?")) {
            ps.setString(1, tenantId);
            ps.setString(2, aggregateType);
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

  const topologyJava = `${p}/**
 * Event bus destinations: events are published to {@code exchange} (RabbitMQ topic exchange / Pub/Sub topic)
 * and consumed from {@code queue} (queue / pull subscription); dead-lettered messages go to {@code dlx}
 * and can be read from {@code dlq}.
 */
public record Topology(String exchange, String queue, String dlx, String dlq) {
    public static final Topology DEFAULT = new Topology(${j(t.exchange)}, ${j(t.queue)}, ${j(t.dlx)}, ${j(t.dlq)});

    public static Topology forPrefix(String prefix) {
        return new Topology(prefix + ".events", prefix + ".consumer", prefix + ".dlx", prefix + ".dlq");
    }
}
`;

  const brokerMessage = `${p}/** A domain event on the wire, independent of the broker. */
public record BrokerMessage(String messageId, String eventType, String tenantId, String traceparent, byte[] body) {}
`;

  const eventPublisher = `${p}/** Publishes to one destination; publish returns only once the broker has durably accepted the message. */
public interface EventPublisher extends AutoCloseable {
    String system();

    String destination();

    void publish(BrokerMessage message) throws Exception;
}
`;

  const eventSubscription = `${p}/** Pulls messages from one queue / subscription. */
public interface EventSubscription extends AutoCloseable {
    @FunctionalInterface
    interface Action {
        void run() throws Exception;
    }

    /** A received message: ack() once processed; deadLetter() moves it to the DLQ (it is not redelivered). */
    record Delivery(BrokerMessage message, Action ack, Action deadLetter) {}

    String system();

    String source();

    /** The next waiting message, or null when there is none. */
    Delivery poll() throws Exception;
}
`;

  const broker = `${p}/**
 * The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on
 * any cloud: GHK_BROKER=rabbitmq (AMQP_URL) or GHK_BROKER=pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT;
 * PUBSUB_EMULATOR_HOST for the emulator). Without GHK_BROKER the configured variables decide.
 */
public interface Broker extends AutoCloseable {
    /** Broker of the generated configuration (stack.messaging). */
    String DEFAULT_KIND = ${j(defaultBroker)};

    String system();

    /** Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code. */
    void declare(Topology topology) throws Exception;

    EventPublisher publisher(String destination) throws Exception;

    /** @param topology where dead-lettered messages go */
    EventSubscription subscribe(String source, Topology topology) throws Exception;

    /** False when topics and subscriptions cannot be created at run time (Service Bus emulator: fixed Config.json). */
    default boolean dynamicTopology() {
        return true;
    }

    static String kind() {
        String explicit = System.getenv("GHK_BROKER");
        if (explicit != null && !explicit.isBlank()) return explicit.trim().toLowerCase();
        if (System.getenv("AMQP_URL") != null) return "rabbitmq";
        if (System.getenv("PUBSUB_PROJECT_ID") != null || System.getenv("PUBSUB_EMULATOR_HOST") != null) return "pubsub";
        if (System.getenv("SERVICEBUS_CONNECTION_STRING") != null || System.getenv("SERVICEBUS_NAMESPACE") != null) return "servicebus";
        return DEFAULT_KIND;
    }

    /** Whether the variables of the selected broker are set. */
    static boolean configured() {
        return switch (kind()) {
            case "pubsub" -> System.getenv("PUBSUB_PROJECT_ID") != null || System.getenv("GOOGLE_CLOUD_PROJECT") != null;
            case "servicebus" -> System.getenv("SERVICEBUS_CONNECTION_STRING") != null || System.getenv("SERVICEBUS_NAMESPACE") != null;
            default -> System.getenv("AMQP_URL") != null && !System.getenv("AMQP_URL").isBlank();
        };
    }

    static Broker fromEnv() throws Exception {
        return switch (kind()) {
            case "pubsub" -> PubSubBroker.fromEnv();
            case "servicebus" -> ${serviceBus ? 'ServiceBusBroker.fromEnv()' : 'throw new IllegalStateException("The Azure Service Bus adapter is not generated: set stack.messaging to \\"servicebus\\" and regenerate")'};
            case "rabbitmq" -> {
                String url = System.getenv("AMQP_URL");
                if (url == null || url.isBlank()) throw new IllegalStateException("AMQP_URL is not set (amqp://user:password@host:5672)");
                yield RabbitMqBroker.connect(url);
            }
            default -> throw new IllegalStateException("Unsupported GHK_BROKER: " + kind() + " (rabbitmq, pubsub, servicebus)");
        };
    }
}
`;

  const rabbit = `${p}import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.GetResponse;
import java.util.HashMap;
import java.util.Map;

/** RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX. */
public final class RabbitMqBroker implements Broker {
    private final com.rabbitmq.client.Connection connection;

    public RabbitMqBroker(com.rabbitmq.client.Connection connection) {
        this.connection = connection;
    }

    public static RabbitMqBroker connect(String url) throws Exception {
        var factory = new com.rabbitmq.client.ConnectionFactory();
        factory.setUri(url);
        factory.setConnectionTimeout(30_000);
        factory.setHandshakeTimeout(30_000);
        // A busy host can delay the AMQP handshake: retry before failing.
        for (int attempt = 1; ; attempt++) {
            try {
                return new RabbitMqBroker(factory.newConnection());
            } catch (java.io.IOException | java.util.concurrent.TimeoutException e) {
                if (attempt == 5) throw e;
                Thread.sleep(2000L * attempt);
            }
        }
    }

    @Override
    public String system() {
        return "rabbitmq";
    }

    @Override
    public void declare(Topology t) throws Exception {
        try (Channel channel = connection.createChannel()) {
            channel.exchangeDeclare(t.exchange(), "topic", true);
            channel.exchangeDeclare(t.dlx(), "fanout", true);
            channel.queueDeclare(t.dlq(), true, false, false, null);
            channel.queueBind(t.dlq(), t.dlx(), "");
            channel.queueDeclare(t.queue(), true, false, false, Map.of("x-dead-letter-exchange", t.dlx()));
            channel.queueBind(t.queue(), t.exchange(), "#");
        }
    }

    @Override
    public EventPublisher publisher(String exchange) throws Exception {
        Channel channel = connection.createChannel();
        channel.confirmSelect();
        return new EventPublisher() {
            @Override
            public String system() {
                return "rabbitmq";
            }

            @Override
            public String destination() {
                return exchange;
            }

            @Override
            public void publish(BrokerMessage m) throws Exception {
                Map<String, Object> headers = new HashMap<>();
                if (m.tenantId() != null) headers.put("tenant_id", m.tenantId());
                if (m.traceparent() != null) headers.put("traceparent", m.traceparent());
                AMQP.BasicProperties props = new AMQP.BasicProperties.Builder()
                    .messageId(m.messageId()).deliveryMode(2).contentType("application/json").type(m.eventType()).headers(headers).build();
                channel.basicPublish(exchange, m.eventType() == null ? "" : m.eventType(), props, m.body());
                channel.waitForConfirmsOrDie(10_000);
            }

            @Override
            public void close() throws Exception {
                if (channel.isOpen()) channel.close();
            }
        };
    }

    @Override
    public EventSubscription subscribe(String queue, Topology topology) throws Exception {
        Channel channel = connection.createChannel();
        return new EventSubscription() {
            @Override
            public String system() {
                return "rabbitmq";
            }

            @Override
            public String source() {
                return queue;
            }

            @Override
            public Delivery poll() throws Exception {
                GetResponse r = channel.basicGet(queue, false);
                if (r == null) return null;
                var props = r.getProps();
                Map<String, Object> h = props.getHeaders() == null ? Map.of() : props.getHeaders();
                long tag = r.getEnvelope().getDeliveryTag();
                BrokerMessage m = new BrokerMessage(props.getMessageId(), props.getType(), text(h.get("tenant_id")), text(h.get("traceparent")), r.getBody());
                // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
                return new Delivery(m, () -> channel.basicAck(tag, false), () -> channel.basicNack(tag, false, false));
            }

            @Override
            public void close() throws Exception {
                if (channel.isOpen()) channel.close();
            }
        };
    }

    private static String text(Object value) {
        return value == null ? null : value.toString();
    }

    @Override
    public void close() throws Exception {
        if (connection.isOpen()) connection.close();
    }
}
`;

  const serviceBusJava = `${p}import com.azure.core.util.BinaryData;
import com.azure.core.util.IterableStream;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.messaging.servicebus.ServiceBusClientBuilder;
import com.azure.messaging.servicebus.ServiceBusMessage;
import com.azure.messaging.servicebus.ServiceBusReceivedMessage;
import com.azure.messaging.servicebus.ServiceBusReceiverClient;
import com.azure.messaging.servicebus.ServiceBusSenderClient;
import com.azure.messaging.servicebus.administration.ServiceBusAdministrationClient;
import com.azure.messaging.servicebus.administration.ServiceBusAdministrationClientBuilder;
import com.azure.messaging.servicebus.models.ServiceBusReceiveMode;
import java.time.Duration;
import java.util.Iterator;
import java.util.List;

/**
 * Azure Service Bus (official SDK, AMQP): topics for the exchange and the DLX, subscriptions for the queue and
 * the DLQ. Auth: SERVICEBUS_CONNECTION_STRING (shared access key; the emulator) or SERVICEBUS_NAMESPACE
 * (e.g. orders.servicebus.windows.net) with Microsoft Entra ID (managed identity in Container Apps / AKS).
 * sendMessage returns once Service Bus has accepted the message. A failed message is dead-lettered by the
 * consumer: sent to the DLX topic, then completed.
 */
public final class ServiceBusBroker implements Broker {
    private final String connectionString;
    private final String namespace;
    private final boolean emulator;

    public ServiceBusBroker(String connectionString, String namespace) {
        this.connectionString = connectionString == null || connectionString.isBlank() ? null : connectionString;
        this.namespace = namespace;
        this.emulator = this.connectionString != null && this.connectionString.contains("UseDevelopmentEmulator=true");
    }

    public static ServiceBusBroker fromEnv() {
        String connectionString = System.getenv("SERVICEBUS_CONNECTION_STRING");
        String namespace = System.getenv("SERVICEBUS_NAMESPACE");
        if ((connectionString == null || connectionString.isBlank()) && (namespace == null || namespace.isBlank())) {
            throw new IllegalStateException("SERVICEBUS_CONNECTION_STRING or SERVICEBUS_NAMESPACE is not set");
        }
        return new ServiceBusBroker(connectionString, namespace);
    }

    private ServiceBusClientBuilder client() {
        ServiceBusClientBuilder builder = new ServiceBusClientBuilder();
        return connectionString != null ? builder.connectionString(connectionString) : builder.credential(namespace, new DefaultAzureCredentialBuilder().build());
    }

    @Override
    public String system() {
        return "servicebus";
    }

    @Override
    public boolean dynamicTopology() {
        return !emulator;
    }

    @Override
    public void declare(Topology t) {
        // The emulator only knows the entities of its Config.json; in Azure they usually come from Terraform.
        if (emulator) return;
        ServiceBusAdministrationClientBuilder builder = new ServiceBusAdministrationClientBuilder();
        ServiceBusAdministrationClient admin = connectionString != null
            ? builder.connectionString(connectionString).buildClient()
            : builder.credential(namespace, new DefaultAzureCredentialBuilder().build()).buildClient();
        for (String topic : List.of(t.exchange(), t.dlx())) {
            if (!admin.getTopicExists(topic)) admin.createTopic(topic);
        }
        if (!admin.getSubscriptionExists(t.exchange(), t.queue())) admin.createSubscription(t.exchange(), t.queue());
        if (!admin.getSubscriptionExists(t.dlx(), t.dlq())) admin.createSubscription(t.dlx(), t.dlq());
    }

    private static ServiceBusMessage toMessage(BrokerMessage m) {
        ServiceBusMessage message = new ServiceBusMessage(BinaryData.fromBytes(m.body()));
        message.setMessageId(m.messageId());
        message.setContentType("application/json");
        if (m.eventType() != null) message.setSubject(m.eventType());
        if (m.tenantId() != null) message.getApplicationProperties().put("tenant_id", m.tenantId());
        if (m.traceparent() != null) message.getApplicationProperties().put("ghk_traceparent", m.traceparent());
        return message;
    }

    @Override
    public EventPublisher publisher(String topic) {
        ServiceBusSenderClient sender = client().sender().topicName(topic).buildClient();
        return new EventPublisher() {
            @Override
            public String system() {
                return "servicebus";
            }

            @Override
            public String destination() {
                return topic;
            }

            @Override
            public void publish(BrokerMessage m) {
                sender.sendMessage(toMessage(m));
            }

            @Override
            public void close() {
                sender.close();
            }
        };
    }

    @Override
    public EventSubscription subscribe(String subscription, Topology topology) {
        String topic = subscription.equals(topology.dlq()) ? topology.dlx() : topology.exchange();
        ServiceBusReceiverClient receiver = client().receiver().topicName(topic).subscriptionName(subscription)
            .receiveMode(ServiceBusReceiveMode.PEEK_LOCK).disableAutoComplete().buildClient();
        return new EventSubscription() {
            private ServiceBusSenderClient deadLetters;

            @Override
            public String system() {
                return "servicebus";
            }

            @Override
            public String source() {
                return subscription;
            }

            @Override
            public Delivery poll() {
                IterableStream<ServiceBusReceivedMessage> received = receiver.receiveMessages(1, Duration.ofMillis(500));
                Iterator<ServiceBusReceivedMessage> it = received.iterator();
                if (!it.hasNext()) return null;
                ServiceBusReceivedMessage msg = it.next();
                Object tenant = msg.getApplicationProperties().get("tenant_id");
                Object traceparent = msg.getApplicationProperties().get("ghk_traceparent");
                BrokerMessage m = new BrokerMessage(msg.getMessageId(), msg.getSubject(), tenant == null ? null : tenant.toString(),
                    traceparent == null ? null : traceparent.toString(), msg.getBody().toBytes());
                return new Delivery(m, () -> receiver.complete(msg), () -> {
                    if (deadLetters == null) deadLetters = client().sender().topicName(topology.dlx()).buildClient();
                    deadLetters.sendMessage(toMessage(m));
                    receiver.complete(msg);
                });
            }

            @Override
            public void close() {
                if (deadLetters != null) deadLetters.close();
                receiver.close();
            }
        };
    }

    @Override
    public void close() {
    }
}
`;

  const pubsub = `${p}import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
 * subscriptions for the queue and the DLQ. publish returns once Pub/Sub has stored the message. A failed
 * message is dead-lettered by the consumer: published to the DLX topic, then acknowledged.
 * Auth: none against the emulator (PUBSUB_EMULATOR_HOST); otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the
 * metadata-server token of the workload's service account (Cloud Run, GKE workload identity).
 */
public final class PubSubBroker implements Broker {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String project;
    private final String root;
    private final boolean emulator;
    private String token;
    private long tokenExpiresAt;

    public PubSubBroker(String project, String emulatorHost) {
        this.project = project;
        this.emulator = emulatorHost != null && !emulatorHost.isBlank();
        this.root = (emulator ? "http://" + emulatorHost : "https://pubsub.googleapis.com") + "/v1/projects/" + project;
    }

    public static PubSubBroker fromEnv() {
        String project = System.getenv("PUBSUB_PROJECT_ID") != null ? System.getenv("PUBSUB_PROJECT_ID") : System.getenv("GOOGLE_CLOUD_PROJECT");
        if (project == null || project.isBlank()) throw new IllegalStateException("PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set");
        return new PubSubBroker(project, System.getenv("PUBSUB_EMULATOR_HOST"));
    }

    @Override
    public String system() {
        return "gcp_pubsub";
    }

    private synchronized String bearer() throws Exception {
        if (emulator) return null;
        String fixed = System.getenv("GOOGLE_OAUTH_ACCESS_TOKEN");
        if (fixed != null && !fixed.isBlank()) return fixed;
        if (token == null || System.currentTimeMillis() > tokenExpiresAt) {
            HttpRequest req = HttpRequest.newBuilder(URI.create(METADATA_TOKEN)).header("Metadata-Flavor", "Google").timeout(Duration.ofSeconds(5)).build();
            JsonNode body = JSON.readTree(http.send(req, HttpResponse.BodyHandlers.ofString()).body());
            token = body.get("access_token").asText();
            tokenExpiresAt = System.currentTimeMillis() + (body.get("expires_in").asLong() - 60) * 1000;
        }
        return token;
    }

    /** Calls the API; a status listed in {@code accepted} returns null instead of failing. */
    private JsonNode call(String method, String path, Object body, int... accepted) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(root + path)).timeout(Duration.ofSeconds(30))
            .header("Content-Type", "application/json")
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        String bearer = bearer();
        if (bearer != null) req.header("Authorization", "Bearer " + bearer);
        HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 == 2) return res.body().isBlank() ? JSON.createObjectNode() : JSON.readTree(res.body());
        for (int status : accepted) if (res.statusCode() == status) return null;
        throw new IOException("Pub/Sub " + method + " " + path + " failed: " + res.statusCode() + " " + res.body());
    }

    @Override
    public void declare(Topology t) throws Exception {
        // 409: it already exists (created earlier or by infrastructure as code).
        call("PUT", "/topics/" + t.exchange(), Map.of(), 409);
        call("PUT", "/topics/" + t.dlx(), Map.of(), 409);
        call("PUT", "/subscriptions/" + t.queue(), Map.of("topic", "projects/" + project + "/topics/" + t.exchange(), "ackDeadlineSeconds", 60), 409);
        call("PUT", "/subscriptions/" + t.dlq(), Map.of("topic", "projects/" + project + "/topics/" + t.dlx(), "ackDeadlineSeconds", 60), 409);
    }

    private void publishTo(String topic, BrokerMessage m) throws Exception {
        Map<String, String> attributes = new HashMap<>();
        attributes.put("ghk_message_id", m.messageId());
        if (m.eventType() != null) attributes.put("event_type", m.eventType());
        if (m.tenantId() != null) attributes.put("tenant_id", m.tenantId());
        if (m.traceparent() != null) attributes.put("traceparent", m.traceparent());
        JsonNode res = call("POST", "/topics/" + topic + ":publish",
            Map.of("messages", List.of(Map.of("data", Base64.getEncoder().encodeToString(m.body()), "attributes", attributes))));
        if (res.path("messageIds").size() != 1) throw new IOException("Pub/Sub did not accept message " + m.messageId());
    }

    @Override
    public EventPublisher publisher(String topic) {
        return new EventPublisher() {
            @Override
            public String system() {
                return "gcp_pubsub";
            }

            @Override
            public String destination() {
                return topic;
            }

            @Override
            public void publish(BrokerMessage m) throws Exception {
                publishTo(topic, m);
            }

            @Override
            public void close() {
            }
        };
    }

    @Override
    public EventSubscription subscribe(String subscription, Topology topology) {
        return new EventSubscription() {
            @Override
            public String system() {
                return "gcp_pubsub";
            }

            @Override
            public String source() {
                return subscription;
            }

            @Override
            public Delivery poll() throws Exception {
                JsonNode received = call("POST", "/subscriptions/" + subscription + ":pull", Map.of("maxMessages", 1, "returnImmediately", true)).path("receivedMessages");
                if (received.size() == 0) return null;
                JsonNode msg = received.get(0).path("message");
                JsonNode attrs = msg.path("attributes");
                String ackId = received.get(0).path("ackId").asText();
                BrokerMessage m = new BrokerMessage(text(attrs, "ghk_message_id", msg.path("messageId").asText()), text(attrs, "event_type", null),
                    text(attrs, "tenant_id", null), text(attrs, "traceparent", null), Base64.getDecoder().decode(msg.path("data").asText("")));
                Action ack = () -> call("POST", "/subscriptions/" + subscription + ":acknowledge", Map.of("ackIds", List.of(ackId)));
                return new Delivery(m, ack, () -> {
                    publishTo(topology.dlx(), m);
                    ack.run();
                });
            }

            @Override
            public void close() {
            }
        };
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? fallback : value.asText();
    }

    @Override
    public void close() {
    }
}
`;

  const relay = `${p}import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so
 * concurrent relays never publish the same row; the publisher returns only once the broker has accepted
 * the message (RabbitMQ confirms, Pub/Sub publish response), before a row is marked published.
 * Use one relay (and publisher) per thread.
 */
public class OutboxRelay {
    private final ConnectionFactory connections;
    private final EventPublisher publisher;
    private final String s;
    private final int leaseSeconds;
    private final int maxAttempts;

    public OutboxRelay(ConnectionFactory connections, EventPublisher publisher, String schema) {
        this.connections = connections;
        this.publisher = publisher;
        this.s = Schema.name(schema);
        this.leaseSeconds = ${LEASE_SECONDS};
        this.maxAttempts = ${MAX_PUBLISH_ATTEMPTS};
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
                Span span = Telemetry.tracer().spanBuilder(publisher.destination() + " publish").setParent(parent).setSpanKind(SpanKind.PRODUCER)
                    .setAttribute("messaging.system", publisher.system()).setAttribute("messaging.destination.name", publisher.destination())
                    .setAttribute("messaging.message.id", row.id()).setAttribute("tenant.id", row.tenantId()).startSpan();
                try {
                    String traceparent = Telemetry.traceparentOf(parent, span);
                    publisher.publish(new BrokerMessage(row.id(), row.eventType(), row.tenantId(), traceparent, row.payload().getBytes(StandardCharsets.UTF_8)));
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
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import java.sql.Connection;
import java.util.Map;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * dead-letters the message (RabbitMQ DLX, Pub/Sub dead-letter topic): it is not redelivered.
 */
public class InboxConsumer {
    public record Meta(String messageId, String tenantId, String eventType, Connection connection) {}

    @FunctionalInterface
    public interface Handler {
        void handle(Map<String, Object> event, Meta meta) throws Exception;
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private final ConnectionFactory connections;
    private final EventSubscription subscription;
    private final String consumerName;
    private final Handler handler;
    private final String s;

    public InboxConsumer(ConnectionFactory connections, EventSubscription subscription, String consumerName, Handler handler, String schema) {
        this.connections = connections;
        this.subscription = subscription;
        this.consumerName = consumerName;
        this.handler = handler;
        this.s = Schema.name(schema);
    }

    /** Processes messages until the source stays empty for idleMillis; returns how many were processed. */
    public int drain(long idleMillis) throws Exception {
        int processed = 0;
        long idleSince = System.currentTimeMillis();
        while (System.currentTimeMillis() - idleSince < idleMillis) {
            EventSubscription.Delivery delivery = subscription.poll();
            if (delivery == null) {
                Thread.sleep(50);
                continue;
            }
            process(delivery);
            processed++;
            idleSince = System.currentTimeMillis();
        }
        return processed;
    }

    @SuppressWarnings("unchecked")
    private void process(EventSubscription.Delivery delivery) throws Exception {
        BrokerMessage message = delivery.message();
        Span span = Telemetry.tracer().spanBuilder(subscription.source() + " process")
            .setParent(Telemetry.contextFrom(message.traceparent())).setSpanKind(SpanKind.CONSUMER)
            .setAttribute("messaging.system", subscription.system()).setAttribute("messaging.destination.name", subscription.source())
            .setAttribute("messaging.message.id", String.valueOf(message.messageId())).startSpan();
        try (Connection conn = connections.open()) {
            conn.setAutoCommit(false);
            try {
                if (CommandService.update(conn, "INSERT INTO " + s + ".ghk_inbox (consumer, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING", consumerName, message.messageId()) == 1) {
                    handler.handle(JSON.readValue(message.body(), Map.class), new Meta(message.messageId(), message.tenantId(), message.eventType(), conn));
                }
                conn.commit();
                delivery.ack().run();
            } catch (Exception e) {
                conn.rollback();
                throw e;
            }
        } catch (Exception e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR);
            delivery.deadLetter().run();
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7). Requires DATABASE_URL and the selected
 * broker (GHK_BROKER: rabbitmq with AMQP_URL, or pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST]).
 */
@Tag("integration")
class RuntimeIntegrationTest {
    private static final String COMMAND = ${j(first.snake)};
    private static final String EVENT = ${j(first.event)};
    private static final InMemorySpanExporter EXPORTER = InMemorySpanExporter.create();
    private static ConnectionFactory connections;
    private static Broker broker;
    private String schema;
    private Topology topology;

    @BeforeAll
    static void connect() throws Exception {
        String dbUrl = System.getenv("DATABASE_URL");
        if (dbUrl == null || !Broker.configured()) throw new IllegalStateException("Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).");
        GlobalOpenTelemetry.resetForTest();
        OpenTelemetrySdk.builder().setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(EXPORTER)).build()).buildAndRegisterGlobal();
        connections = ConnectionFactory.fromUrl(dbUrl);
        broker = Broker.fromEnv();
    }

    @AfterAll
    static void disconnect() throws Exception {
        if (broker != null) broker.close();
    }

    @BeforeEach
    void freshSchema() throws Exception {
        String uid = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        schema = "it_" + uid;
        // Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
        topology = broker.dynamicTopology() ? Topology.forPrefix("it-" + uid) : Topology.forPrefix("it");
        Schema.migrate(connections, schema);
        broker.declare(topology);
        if (!broker.dynamicTopology()) {
            receive(topology.queue(), 0);
            receive(topology.dlq(), 0);
        }
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

    /** Receives and acknowledges messages until the expected number arrived and the source stays quiet for 500 ms (10 s at most). */
    private List<BrokerMessage> receive(String source, int expected) throws Exception {
        List<BrokerMessage> out = new ArrayList<>();
        try (EventSubscription subscription = broker.subscribe(source, topology)) {
            long deadline = System.currentTimeMillis() + 10_000;
            long quietSince = System.currentTimeMillis();
            while (System.currentTimeMillis() < deadline && (out.size() < expected || System.currentTimeMillis() - quietSince < 500)) {
                EventSubscription.Delivery delivery = subscription.poll();
                if (delivery == null) {
                    Thread.sleep(50);
                    continue;
                }
                out.add(delivery.message());
                delivery.ack().run();
                quietSince = System.currentTimeMillis();
            }
        }
        return out;
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
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Future<Integer>> totals = new ArrayList<>();
        for (String worker : List.of("relay-a", "relay-b")) {
            totals.add(pool.submit(() -> {
                try (EventPublisher publisher = broker.publisher(topology.exchange())) {
                    var relay = new OutboxRelay(connections, publisher, schema);
                    int total = 0;
                    for (int n = relay.publishBatch(worker, 3); n > 0; n = relay.publishBatch(worker, 3)) total += n;
                    return total;
                }
            }));
        }
        int published = 0;
        for (var t : totals) published += t.get();
        pool.shutdown();
        assertEquals(20, published);
        assertEquals(0, count("ghk_outbox", "published_at IS NULL"));
        List<BrokerMessage> received = receive(topology.queue(), 20);
        assertEquals(20, received.size());
        Set<String> ids = new HashSet<>();
        for (BrokerMessage m : received) ids.add(m.messageId());
        assertEquals(20, ids.size());
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
        List<String> handled = new ArrayList<>();
        try (EventPublisher publisher = broker.publisher(topology.exchange());
             EventSubscription subscription = broker.subscribe(topology.queue(), topology)) {
            var consumer = new InboxConsumer(connections, subscription, "it-consumer", (event, meta) -> {
                if (Boolean.TRUE.equals(event.get("poison"))) throw new IllegalStateException("cannot process");
                handled.add(meta.messageId());
            }, schema);
            for (String[] m : new String[][] {{"m-1", "{\\"ok\\": true}"}, {"m-1", "{\\"ok\\": true}"}, {"m-poison", "{\\"poison\\": true}"}}) {
                publisher.publish(new BrokerMessage(m[0], "Test", "t1", null, m[1].getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            }
            consumer.drain(1000);
        }
        assertEquals(List.of("m-1"), handled);
        assertEquals(1, count("ghk_inbox", "consumer = ?", "it-consumer"));
        List<BrokerMessage> dead = receive(topology.dlq(), 1);
        assertEquals(1, dead.size());
        assertEquals("m-poison", dead.get(0).messageId());
    }

    @Test
    void it7TraceContextPropagation() throws Exception {
        var service = new CommandService(connections, schema);
        service.handle(new CommandService.Request("t1", "agg-1", COMMAND, Map.of(), null, ${j(TEST_TRACEPARENT)}));
        try (Connection conn = connections.open(); Statement st = conn.createStatement(); ResultSet rs = st.executeQuery("SELECT traceparent FROM " + schema + ".ghk_outbox")) {
            rs.next();
            assertTrue(rs.getString(1).contains(${j(TEST_TRACE_ID)}));
        }
        try (EventPublisher publisher = broker.publisher(topology.exchange())) {
            assertEquals(1, new OutboxRelay(connections, publisher, schema).publishBatch("relay", 10));
        }
        List<String> received = new ArrayList<>();
        try (EventSubscription subscription = broker.subscribe(topology.queue(), topology)) {
            new InboxConsumer(connections, subscription, "trace-consumer", (event, meta) -> received.add(meta.messageId()), schema).drain(1000);
        }
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
    }
}
`;

  return [
    { filename: `${dir}/ConnectionFactory.java`, content: connections },
    { filename: `${dir}/Schema.java`, content: schema },
    { filename: `${dir}/Telemetry.java`, content: telemetry },
    { filename: `${dir}/CommandService.java`, content: commandService },
    { filename: `${dir}/Topology.java`, content: topologyJava },
    { filename: `${dir}/BrokerMessage.java`, content: brokerMessage },
    { filename: `${dir}/EventPublisher.java`, content: eventPublisher },
    { filename: `${dir}/EventSubscription.java`, content: eventSubscription },
    { filename: `${dir}/Broker.java`, content: broker },
    { filename: `${dir}/RabbitMqBroker.java`, content: rabbit },
    { filename: `${dir}/PubSubBroker.java`, content: pubsub },
    ...(serviceBus ? [{ filename: `${dir}/ServiceBusBroker.java`, content: serviceBusJava }] : []),
    { filename: `${dir}/OutboxRelay.java`, content: relay },
    { filename: `${dir}/InboxConsumer.java`, content: inbox },
    { filename: `${dir}/SagaOrchestrator.java`, content: saga },
    { filename: `${testDir}/RuntimeIntegrationTest.java`, content: test }
  ];
}
