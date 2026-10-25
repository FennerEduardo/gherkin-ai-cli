package com.lms.assessmentservice.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    private static final String COMMAND = "publish_grade";
    private static final String EVENT = "SubmissionGraded";
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
        for (String[] m : new String[][] {{"m-1", "{\"ok\": true}"}, {"m-1", "{\"ok\": true}"}, {"m-poison", "{\"poison\": true}"}}) {
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
        service.handle(new CommandService.Request("t1", "agg-1", COMMAND, Map.of(), null, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"));
        try (Connection conn = connections.open(); Statement st = conn.createStatement(); ResultSet rs = st.executeQuery("SELECT traceparent FROM " + schema + ".ghk_outbox")) {
            rs.next();
            assertTrue(rs.getString(1).contains("4bf92f3577b34da6a3ce929d0e0e4736"));
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
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", command.getTraceId());
        assertEquals("00f067aa0ba902b7", command.getParentSpanId());
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", producer.getTraceId());
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", consumer.getTraceId());
        assertEquals(producer.getSpanId(), consumer.getParentSpanId());
        channel.close();
    }
}
