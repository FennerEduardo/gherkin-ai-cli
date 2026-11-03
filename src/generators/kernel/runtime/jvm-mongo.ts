/* ==========================================================================
   gherkin-ai-cli - The JVM runtime kernel on MongoDB 8 (stack.kernelDatabase
   "mongodb"; PLAN-3.3.0 X-02). Spring Boot, Java.

   Same design as the TypeScript kernel on MongoDB (typescript-mongo.ts):
     - ConnectionFactory keeps its name and fromUrl(), now over one
       MongoClient (mongodb-driver-sync), with inTransaction(): a
       transaction run again on a transient error, a write conflict or a
       duplicate key from a concurrent insert (PostgreSQL's row locks wait
       for the other writer instead);
     - collections with the kernel's column names and unique indexes; a
       schema is a database ("public" is the one in DATABASE_URL);
     - the command service and the inbox in transactions; the outbox claimed
       one event at a time with an atomic findOneAndUpdate and a lease on the
       server's clock ($$NOW);
     - Spring: no DataSource or JPA (the pom drops spring-boot-starter-data-jpa
       and the PostgreSQL driver); readiness pings MongoDB.
   The public signatures keep `throws SQLException`, so callers compile
   unchanged. Transactions need a replica set (one node is enough).
   ========================================================================== */

import { LEASE_SECONDS, MAX_PUBLISH_ATTEMPTS } from './shared';

type File = { filename: string; content: string };

/** Version managed by spring-boot-starter-parent (it must match the driver-core it brings). */
export const MONGO_JAVA_DRIVER = { groupId: 'org.mongodb', artifactId: 'mongodb-driver-sync' };

const pkgOf = (content: string) => content.match(/^package ([\w.]+);/m)?.[1] ?? '';

function connectionFactoryJava(p: string): string {
  return `${p}import com.mongodb.ConnectionString;
import com.mongodb.MongoException;
import com.mongodb.ReadConcern;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoDatabase;
import java.util.Set;
import org.bson.Document;

/**
 * The kernel's MongoDB connection (stack.kernelDatabase "mongodb"): one MongoClient, pooled and thread-safe.
 * Transactions need a replica set; one node is enough.
 */
public final class ConnectionFactory implements AutoCloseable {
    /** WriteConflict, DuplicateKey (a concurrent insert of the same key), NoSuchTransaction. */
    private static final Set<Integer> RETRYABLE = Set.of(112, 11000, 251);

    /** Work done in a transaction. */
    @FunctionalInterface
    public interface Work<T> {
        T run(ClientSession session);
    }

    private final MongoClient client;
    private final String database;

    private ConnectionFactory(MongoClient client, String database) {
        this.client = client;
        this.database = database;
    }

    /** From mongodb://host:27017/database?replicaSet=rs0 (or mongodb+srv://...). */
    public static ConnectionFactory fromUrl(String databaseUrl) {
        ConnectionString url = new ConnectionString(databaseUrl);
        return new ConnectionFactory(MongoClients.create(url), url.getDatabase() == null || url.getDatabase().isEmpty() ? "app" : url.getDatabase());
    }

    /** The database in DATABASE_URL. */
    public String defaultDatabase() {
        return database;
    }

    public MongoDatabase database(String name) {
        return client.getDatabase(name);
    }

    /** Readiness probe. */
    public void ping() {
        client.getDatabase(database).runCommand(new Document("ping", 1));
    }

    /**
     * Runs work in a transaction (snapshot reads, majority writes). On a transient error, a write conflict or a
     * duplicate key from a concurrent transaction the work runs again on fresh data: the concurrent writer has
     * committed by then, as a PostgreSQL row lock would have waited for it. Other errors propagate.
     */
    public <T> T inTransaction(Work<T> work) {
        for (int attempt = 1; ; attempt++) {
            try (ClientSession session = client.startSession()) {
                session.startTransaction(TransactionOptions.builder().readConcern(ReadConcern.SNAPSHOT).writeConcern(WriteConcern.MAJORITY).build());
                try {
                    T result = work.run(session);
                    commit(session);
                    return result;
                } catch (RuntimeException e) {
                    if (session.hasActiveTransaction()) {
                        try { session.abortTransaction(); } catch (RuntimeException ignored) { }
                    }
                    if (attempt < 60 && retryable(e)) {
                        sleep(Math.min(5L * attempt, 100L));
                        continue;
                    }
                    throw e;
                }
            }
        }
    }

    private static void commit(ClientSession session) {
        for (int attempt = 1; ; attempt++) {
            try {
                session.commitTransaction();
                return;
            } catch (MongoException e) {
                if (attempt < 5 && e.hasErrorLabel(MongoException.UNKNOWN_TRANSACTION_COMMIT_RESULT_LABEL)) continue;
                throw e;
            }
        }
    }

    private static boolean retryable(RuntimeException e) {
        return e instanceof MongoException m && (m.hasErrorLabel(MongoException.TRANSIENT_TRANSACTION_ERROR_LABEL) || RETRYABLE.contains(m.getCode()));
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() {
        client.close();
    }
}
`;
}

function schemaJava(p: string): string {
  return `${p}import com.mongodb.MongoCommandException;
import com.mongodb.client.MongoDatabase;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** The kernel's collections on MongoDB (docs/RUNTIME-KERNEL.md): a schema is a database. */
public final class Schema {
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_-]{1,63}");
    /** Collections and their keys (unique indexes). */
    private static final Map<String, List<String[]>> COLLECTIONS = new LinkedHashMap<>();
    static {
        COLLECTIONS.put("ghk_aggregates", List.<String[]>of(new String[] {"tenant_id", "aggregate_type", "id"}));
        COLLECTIONS.put("ghk_outbox", List.of());
        COLLECTIONS.put("ghk_idempotency", List.<String[]>of(new String[] {"tenant_id", "key"}));
        COLLECTIONS.put("ghk_inbox", List.<String[]>of(new String[] {"consumer", "message_id"}));
        COLLECTIONS.put("ghk_sagas", List.of());
    }

    // Tenant isolation is the repository filter (tenant_id in every query).

    private Schema() {}

    /** Validated database name; "public" (or none) is the database of DATABASE_URL. */
    public static String name(String schema, ConnectionFactory connections) {
        String s = schema == null || schema.isEmpty() || "public".equals(schema) ? connections.defaultDatabase() : schema;
        if (!NAME.matcher(s).matches()) throw new IllegalArgumentException("Invalid schema name: " + s);
        return s;
    }

    /** Creates the collections and indexes (idempotent); they exist before any transaction writes to them. */
    public static void migrate(ConnectionFactory connections, String schema) {
        MongoDatabase db = connections.database(name(schema, connections));
        Set<String> existing = db.listCollectionNames().into(new HashSet<>());
        for (Map.Entry<String, List<String[]>> collection : COLLECTIONS.entrySet()) {
            if (!existing.contains(collection.getKey())) {
                try {
                    db.createCollection(collection.getKey());
                } catch (MongoCommandException e) {
                    if (e.getErrorCode() != 48) throw e; // created by a replica starting at the same time
                }
            }
            for (String[] key : collection.getValue()) db.getCollection(collection.getKey()).createIndex(Indexes.ascending(key), new IndexOptions().unique(true));
        }
        db.getCollection("ghk_outbox").createIndex(Indexes.ascending("published_at", "failed_at", "created_at"));
    }
}
`;
}

const HANDLE = `    public Result handle(Request req) throws SQLException {
        if (req.tenantId() == null || req.tenantId().isBlank()) throw new DomainValidationException("tenantId is required");
        Context parent = Telemetry.contextFrom(req.traceparent());
        Span span = Telemetry.tracer().spanBuilder(SPAN_PREFIX + req.command()).setParent(parent).setSpanKind(SpanKind.INTERNAL)
            .setAttribute("tenant.id", req.tenantId()).setAttribute("aggregate.id", req.aggregateId()).startSpan();
        try {
            String traceparent = Telemetry.traceparentOf(parent, span);
            // A concurrent change of the same aggregate is a write conflict: the transaction runs again on its result.
            return connections.inTransaction(session -> execute(session, req, traceparent));
        } catch (RuntimeException e) {
            span.recordException(e);
            span.setStatus(StatusCode.ERROR, e.getMessage());
            throw e;
        } finally {
            span.end();
        }
    }

    private Result execute(ClientSession session, Request req, String traceparent) {
        MongoDatabase db = connections.database(s);
        String key = req.idempotencyKey();
        if (key != null) {
            Document claim = new Document("tenant_id", req.tenantId()).append("key", key);
            Document done = db.getCollection("ghk_idempotency").find(session, claim).first();
            if (done != null) {
                if ("COMPLETED".equals(done.getString("status"))) {
                    Result stored = readJson(done.getString("response"));
                    return new Result("replayed", stored.aggregateId(), stored.eventType(), stored.version());
                }
                return new Result("in-progress", req.aggregateId(), null, null);
            }
            db.getCollection("ghk_idempotency").insertOne(session, new Document(claim).append("status", "PROCESSING").append("created_at", new Date()));
        }
        String type = req.type();
        Document id = new Document("tenant_id", req.tenantId()).append("aggregate_type", type).append("id", req.aggregateId());
        Document row = db.getCollection("ghk_aggregates").find(session, id).first();
        String state = row == null ? null : row.getString("state");
        long version = row == null ? 0 : ((Number) row.get("version")).longValue();
        Map<String, Object> payload = req.payload() == null ? Map.of() : req.payload();
        Applied applied = switch (type) {
CASES
            default -> throw new DomainValidationException("Unknown aggregate type " + type);
        };
        db.getCollection("ghk_aggregates").updateOne(session, id,
            new Document("$set", new Document("state", applied.state()).append("version", applied.version()).append("updated_at", new Date())),
            new UpdateOptions().upsert(true));
        db.getCollection("ghk_outbox").insertOne(session, new Document("_id", UUID.randomUUID().toString())
            .append("tenant_id", req.tenantId()).append("aggregate_id", req.aggregateId()).append("event_type", applied.eventType())
            .append("payload", writeJson(applied.event())).append("traceparent", traceparent).append("created_at", new Date())
            .append("claimed_by", null).append("claimed_until", null).append("published_at", null)
            .append("attempts", 0).append("last_error", null).append("failed_at", null));
        Result result = new Result("created", req.aggregateId(), applied.eventType(), applied.eventVersion());
        if (key != null) {
            db.getCollection("ghk_idempotency").updateOne(session, new Document("tenant_id", req.tenantId()).append("key", key),
                new Document("$set", new Document("status", "COMPLETED").append("response", writeJson(result))));
        }
        return result;
    }

`;

const LOAD = `    public Optional<Snapshot> load(String tenantId, String aggregateId, String aggregateType) throws SQLException {
        Document row = connections.database(s).getCollection("ghk_aggregates")
            .find(new Document("tenant_id", tenantId).append("aggregate_type", aggregateType).append("id", aggregateId)).first();
        return row == null ? Optional.empty() : Optional.of(new Snapshot(row.getString("state"), ((Number) row.get("version")).longValue()));
    }

`;

function relayJava(p: string): string {
  return `${p}import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.FindOneAndUpdateOptions;
import com.mongodb.client.model.ReturnDocument;
import com.mongodb.client.model.Sorts;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Context;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.bson.Document;

/**
 * Publishes pending outbox events. Each one is claimed with an atomic findOneAndUpdate and a lease on the server's
 * clock, so concurrent relays never publish the same event; the publisher returns only once the broker has accepted
 * the message, before it is marked published. Use one relay (and publisher) per thread.
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
        this.s = Schema.name(schema, connections);
        this.leaseSeconds = ${LEASE_SECONDS};
        this.maxAttempts = ${MAX_PUBLISH_ATTEMPTS};
    }

    /** The oldest pending event nobody holds a lease on, leased to workerId. */
    private Document claim(MongoCollection<Document> outbox, String workerId) {
        Document pending = new Document("published_at", null).append("failed_at", null)
            .append("$or", List.of(new Document("claimed_until", null), new Document("$expr", new Document("$lt", List.of("$claimed_until", "$$NOW")))));
        List<Document> lease = List.of(new Document("$set", new Document("claimed_by", new Document("$literal", workerId))
            .append("claimed_until", new Document("$add", List.of("$$NOW", leaseSeconds * 1000L)))
            .append("attempts", new Document("$add", List.of("$attempts", 1)))));
        return outbox.findOneAndUpdate(pending, lease, new FindOneAndUpdateOptions().sort(Sorts.ascending("created_at", "_id")).returnDocument(ReturnDocument.AFTER));
    }

    public int publishBatch(String workerId, int limit) throws Exception {
        MongoCollection<Document> outbox = connections.database(s).getCollection("ghk_outbox");
        int published = 0;
        for (int n = 0; n < limit; n++) {
            Document row = claim(outbox, workerId);
            if (row == null) break;
            String id = row.getString("_id");
            String tenantId = row.getString("tenant_id");
            Context parent = Telemetry.contextFrom(row.getString("traceparent"));
            Span span = Telemetry.tracer().spanBuilder(publisher.destination() + " publish").setParent(parent).setSpanKind(SpanKind.PRODUCER)
                .setAttribute("messaging.system", publisher.system()).setAttribute("messaging.destination.name", publisher.destination())
                .setAttribute("messaging.message.id", id).setAttribute("tenant.id", tenantId).startSpan();
            try {
                String traceparent = Telemetry.traceparentOf(parent, span);
                publisher.publish(new BrokerMessage(id, row.getString("event_type"), tenantId, traceparent, row.getString("payload").getBytes(StandardCharsets.UTF_8)));
                outbox.updateOne(new Document("_id", id).append("claimed_by", workerId),
                    List.of(new Document("$set", new Document("published_at", "$$NOW").append("claimed_until", null))));
                published++;
            } catch (Exception e) {
                span.recordException(e);
                span.setStatus(StatusCode.ERROR);
                outbox.updateOne(new Document("_id", id), List.of(new Document("$set", new Document("claimed_until", null)
                    .append("last_error", new Document("$literal", String.valueOf(e.getMessage())))
                    .append("failed_at", new Document("$cond", List.of(new Document("$gte", List.of("$attempts", maxAttempts)), "$$NOW", null))))));
            } finally {
                span.end();
            }
        }
        return published;
    }
}
`;
}

function inboxJava(p: string): string {
  return `${p}import com.fasterxml.jackson.databind.ObjectMapper;
import com.mongodb.client.ClientSession;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import java.util.Date;
import java.util.Map;
import org.bson.Document;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * dead-letters the message: it is not redelivered. A write conflict runs the transaction (and the
 * handler) again: keep the handler's effects in the session.
 */
public class InboxConsumer {
    /** session: the transaction the inbox record is written in; pass it to the handler's own writes. */
    public record Meta(String messageId, String tenantId, String eventType, ClientSession session, MongoDatabase database) {}

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
        this.s = Schema.name(schema, connections);
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
        try {
            MongoDatabase db = connections.database(s);
            connections.inTransaction(session -> {
                MongoCollection<Document> inbox = db.getCollection("ghk_inbox");
                Document key = new Document("consumer", consumerName).append("message_id", message.messageId());
                if (inbox.find(session, key).first() != null) return null;
                inbox.insertOne(session, new Document(key).append("processed_at", new Date()));
                try {
                    handler.handle(JSON.readValue(message.body(), Map.class), new Meta(message.messageId(), message.tenantId(), message.eventType(), session, db));
                } catch (RuntimeException e) {
                    throw e;
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
                return null;
            });
            delivery.ack().run();
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
}

function sagaJava(p: string): string {
  return `${p}import com.mongodb.MongoWriteException;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.UpdateOptions;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import org.bson.Document;

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
        this.s = Schema.name(schema, connections);
    }

    private MongoCollection<Document> sagas() {
        return connections.database(s).getCollection("ghk_sagas");
    }

    public String run(String sagaId, String tenantId, List<Step> steps) throws Exception {
        try {
            sagas().updateOne(new Document("_id", sagaId),
                new Document("$setOnInsert", new Document("tenant_id", tenantId).append("status", "RUNNING").append("completed_steps", "").append("updated_at", new Date())),
                new UpdateOptions().upsert(true));
        } catch (MongoWriteException e) {
            if (e.getCode() != 11000) throw e; // a concurrent run created it
        }
        Document row = sagas().find(new Document("_id", sagaId).append("tenant_id", tenantId)).first();
        List<String> completed = new ArrayList<>(row == null ? List.of() : split(row.getString("completed_steps")));
        for (Step step : steps) {
            if (completed.contains(step.name())) continue;
            try {
                step.action().run();
            } catch (Exception failure) {
                save(sagaId, "COMPENSATING", completed);
                for (int i = completed.size() - 1; i >= 0; i--) {
                    String name = completed.get(i);
                    steps.stream().filter(x -> x.name().equals(name)).findFirst().orElseThrow().compensate().run();
                    completed.remove(i);
                    save(sagaId, "COMPENSATING", completed);
                }
                save(sagaId, "COMPENSATED", completed);
                return "COMPENSATED";
            }
            completed.add(step.name());
            save(sagaId, "RUNNING", completed);
        }
        save(sagaId, "COMPLETED", completed);
        return "COMPLETED";
    }

    public Optional<Status> status(String sagaId) throws SQLException {
        Document row = sagas().find(new Document("_id", sagaId)).first();
        return row == null ? Optional.empty() : Optional.of(new Status(row.getString("status"), split(row.getString("completed_steps"))));
    }

    private static List<String> split(String done) {
        return done == null || done.isEmpty() ? List.of() : Arrays.asList(done.split(","));
    }

    private void save(String sagaId, String status, List<String> completed) {
        sagas().updateOne(new Document("_id", sagaId), new Document("$set", new Document("status", status).append("completed_steps", String.join(",", completed)).append("updated_at", new Date())));
    }
}
`;
}

function commandServiceJava(content: string): string {
  const cases = content.match(/ {12}case "[^"]+" -> apply\w+\(req\.aggregateId\(\), state, version, req\.command\(\), payload\);/g)?.join('\n') ?? '';
  const spanPrefix = content.match(/spanBuilder\(("[^"]*") \+ req\.command\(\)\)/)?.[1] ?? '""';
  return content
    .replace(/import java\.sql\.Connection;\nimport java\.sql\.PreparedStatement;\nimport java\.sql\.ResultSet;\n/, '')
    .replace('import java.util.Map;', 'import com.mongodb.client.ClientSession;\nimport com.mongodb.client.MongoDatabase;\nimport com.mongodb.client.model.UpdateOptions;\nimport java.util.Date;\nimport java.util.Map;')
    .replace('import java.util.UUID;', 'import java.util.UUID;\nimport org.bson.Document;')
    .replace(/ \* Executes a command in one transaction: idempotency claim, aggregate load \(FOR UPDATE\), domain\n \* logic, aggregate save and outbox insert\. A domain error rolls back everything\./,
      ' * Executes a command in one MongoDB transaction: idempotency lookup, aggregate load, domain logic,\n * aggregate save and outbox insert. A domain error aborts everything; a concurrent writer makes it run again.')
    .replace('    private static final ObjectMapper JSON', `    private static final String SPAN_PREFIX = ${spanPrefix};\n    private static final ObjectMapper JSON`)
    .replace('this.s = Schema.name(schema);', 'this.s = Schema.name(schema, connections);')
    .replace(/ {4}public Result handle\(Request req\) throws SQLException \{[\s\S]*?\n(?= {4}private static Applied apply)/, () => HANDLE.replace('CASES', cases))
    .replace(/ {4}public Optional<Snapshot> load\(String tenantId, String aggregateId, String aggregateType\) throws SQLException \{[\s\S]*?\n(?= {4}private static String writeJson)/, () => LOAD);
}

function healthJava(pkg: string): string {
  return `package ${pkg}.api;

import ${pkg}.runtime.ConnectionFactory;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Probes for container platforms: /health (process is up) and /health/ready (database reachable). */
@RestController
public class HealthController {
    private final ConnectionFactory connections;

    public HealthController(ConnectionFactory connections) {
        this.connections = connections;
    }

    @GetMapping("/health")
    public Map<String, String> live() {
        return Map.of("status", "ok");
    }

    @GetMapping("/health/ready")
    public ResponseEntity<Map<String, String>> ready() {
        try {
            connections.ping();
            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("status", "unavailable"));
        }
    }
}
`;
}

const CONNECTION_BEAN = `    /**
     * The kernel's MongoDB client from DATABASE_URL. Its collections are created before anything uses it (the
     * command service, the relay): idempotent. GHK_MIGRATE=false when another tool owns them.
     */
    @Bean(destroyMethod = "close")
    public ConnectionFactory connectionFactory(@Value("\${ghk.schema.migrate:true}") boolean migrate) {
        String url = System.getenv("DATABASE_URL");
        if (url == null || url.isBlank()) throw new IllegalStateException("DATABASE_URL is not set (mongodb://host:27017/db?replicaSet=rs0)");
        ConnectionFactory connections = ConnectionFactory.fromUrl(url);
        if (migrate) Schema.migrate(connections, "public");
        return connections;
    }
`;

const OUTBOX_CHECK = /try \(Connection conn = ConnectionFactory\.fromUrl\(System\.getenv\("DATABASE_URL"\)\)\.open\(\);\n\s+PreparedStatement ps = conn\.prepareStatement\("SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = \?"\)\) \{[\s\S]*?\n {8}\}\n/;

/** Adapts a generated Spring Boot (Java) project (PostgreSQL kernel) to MongoDB; also its pom (contracts.ts). */
export function mongoizeJvmProject(files: File[]): File[] {
  return files.map(f => {
    const name = f.filename.split('/').pop() ?? '';
    const p = `package ${pkgOf(f.content)};\n\n`;
    if (/\/runtime\/ConnectionFactory\.java$/.test(f.filename)) return { ...f, content: connectionFactoryJava(p) };
    if (/\/runtime\/Schema\.java$/.test(f.filename)) return { ...f, content: schemaJava(p) };
    if (/\/runtime\/OutboxRelay\.java$/.test(f.filename)) return { ...f, content: relayJava(p) };
    if (/\/runtime\/InboxConsumer\.java$/.test(f.filename)) return { ...f, content: inboxJava(p) };
    if (/\/runtime\/SagaOrchestrator\.java$/.test(f.filename)) return { ...f, content: sagaJava(p) };
    if (/\/runtime\/CommandService\.java$/.test(f.filename)) return { ...f, content: commandServiceJava(f.content) };
    if (/\/api\/HealthController\.java$/.test(f.filename)) return { ...f, content: healthJava(pkgOf(f.content).replace(/\.api$/, '')) };
    if (name === 'RuntimeConfiguration.java') {
      return {
        ...f, content: f.content
          .replace(/import javax\.sql\.DataSource;\n/, '')
          .replace(/import org\.springframework\.boot\.jdbc\.DataSourceBuilder;\n/, '')
          .replace(/ \* Wires the runtime kernel into Spring: a pooled DataSource from DATABASE_URL \(libpq URL, shared with\n \* JPA\), the CommandService, and the outbox relay below\./,
            ' * Wires the runtime kernel into Spring: the MongoDB client from DATABASE_URL, the CommandService, and the\n * outbox relay below.')
          .replace(/ {4}@Bean\n {4}public DataSource dataSource\(\) \{[\s\S]*?\n {4}@Bean\n {4}public CommandService/, () => `${CONNECTION_BEAN}\n    @Bean\n    public CommandService`)
      };
    }
    if (name === 'RuntimeIntegrationTest.java') {
      return {
        ...f, content: f.content
          .replace('import java.util.ArrayList;', 'import java.util.ArrayList;\nimport org.bson.Document;')
          .replace(/try \(Connection conn = connections\.open\(\); Statement st = conn\.createStatement\(\)\) \{\n\s+st\.execute\("DROP SCHEMA IF EXISTS " \+ schema \+ " CASCADE"\);\n\s+\}/, 'connections.database(schema).drop();')
          .replace(/ {4}private int count\(String table, String where, Object\.\.\. args\) throws Exception \{[\s\S]*?\n {4}\}\n/,
            '    private long count(String collection, Document filter) {\n        return connections.database(schema).getCollection(collection).countDocuments(filter);\n    }\n')
          .replace(/count\("(\w+)", "(\w+) = \?", ("[^"]*")\)/g, 'count("$1", new Document("$2", $3))')
          .replace(/count\("(\w+)", "(\w+) IS NULL"\)/g, 'count("$1", new Document("$2", null))')
          .replace(/count\("(\w+)", "true"\)/g, 'count("$1", new Document())')
          .replace(/try \(Connection conn = connections\.open\(\); Statement st = conn\.createStatement\(\); ResultSet rs = st\.executeQuery\("SELECT traceparent FROM " \+ schema \+ "\.ghk_outbox"\)\) \{\n\s+rs\.next\(\);\n\s+assertTrue\(rs\.getString\(1\)\.contains\(("[^"]*")\)\);\n\s+\}/,
            (_m, id: string) => `assertTrue(connections.database(schema).getCollection("ghk_outbox").find().first().getString("traceparent").contains(${id}));`)
      };
    }
    if (/HttpIntegrationTest\.java$/.test(name)) {
      return {
        ...f, content: f.content
          .replace(OUTBOX_CHECK, () => `try (ConnectionFactory connections = ConnectionFactory.fromUrl(System.getenv("DATABASE_URL"))) {
            org.bson.Document row = connections.database(connections.defaultDatabase()).getCollection("ghk_outbox").find(new org.bson.Document("aggregate_id", id)).first();
            assertTrue(row != null);
            assertEquals(tenant, row.getString("tenant_id"));
        }
`)
          .replace('against PostgreSQL (needs DATABASE_URL)', 'against MongoDB (needs DATABASE_URL)')
      };
    }
    if (name === 'pom.xml') {
      return {
        ...f, content: f.content
          .replace(/ {4}<dependency>\n {6}<groupId>org\.springframework\.boot<\/groupId>\n {6}<artifactId>spring-boot-starter-data-jpa<\/artifactId>\n {4}<\/dependency>\n/, '')
          .replace(/<groupId>org\.postgresql<\/groupId>\n {6}<artifactId>postgresql<\/artifactId>\n {6}<scope>runtime<\/scope>/,
            // No version: spring-boot-starter-parent manages the MongoDB driver, and driver-sync must match its driver-core.
            `<groupId>${MONGO_JAVA_DRIVER.groupId}</groupId>\n      <artifactId>${MONGO_JAVA_DRIVER.artifactId}</artifactId>`)
      };
    }
    if (name === 'application.properties') {
      return { ...f, content: f.content.replace(/# The runtime kernel creates its own tables[^\n]*\n# the schema[^\n]*\nspring\.jpa\.hibernate\.ddl-auto=none\nspring\.jpa\.open-in-view=false\n/, '# The runtime kernel creates its collections when the service starts (Schema.migrate). GHK_MIGRATE=false when another tool owns them.\n') };
    }
    return f;
  });
}
