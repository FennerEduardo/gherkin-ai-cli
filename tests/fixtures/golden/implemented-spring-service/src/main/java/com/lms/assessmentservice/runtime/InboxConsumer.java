package com.lms.assessmentservice.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
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
