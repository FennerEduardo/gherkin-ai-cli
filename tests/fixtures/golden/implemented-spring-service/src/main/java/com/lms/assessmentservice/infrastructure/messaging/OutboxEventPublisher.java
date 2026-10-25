package com.lms.assessmentservice.infrastructure.messaging;

import com.lms.assessmentservice.application.port.EventPublisher;
import com.lms.assessmentservice.domain.shared.DomainEvent;
import com.lms.assessmentservice.infrastructure.web.RequestContext;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Transactional outbox (definitions §42): the envelope is inserted into the kernel's ghk_outbox in
 * the caller's transaction, together with the business change. runtime/OutboxRelay publishes it;
 * the row id is the eventId and becomes the AMQP message id used for consumer deduplication.
 */
public class OutboxEventPublisher implements EventPublisher {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final String producer;

    public OutboxEventPublisher(JdbcTemplate jdbc, ObjectMapper json, String producer) {
        this.jdbc = jdbc;
        this.json = json;
        this.producer = producer;
    }

    @Override
    public void publish(String tenantId, List<DomainEvent> events) {
        String correlationId = RequestContext.correlationId() != null ? RequestContext.correlationId() : UUID.randomUUID().toString();
        String traceparent = currentTraceparent();
        for (DomainEvent event : events) {
            String eventId = UUID.randomUUID().toString();
            var envelope = new EventEnvelope(eventId, event.type(), 1, event.occurredAt(), correlationId, RequestContext.causationId(),
                tenantId, producer, event.payload());
            jdbc.update("INSERT INTO ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES (?, ?, ?, ?, ?, ?)",
                eventId, tenantId, event.aggregateId(), event.type(), write(envelope), traceparent);
        }
    }

    private String write(EventEnvelope envelope) {
        try {
            return json.writeValueAsString(envelope);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot serialize " + envelope.eventType(), e);
        }
    }

    /** W3C traceparent of the current span, so the relay and consumers continue the same trace. */
    private static String currentTraceparent() {
        if (!Span.current().getSpanContext().isValid()) return null;
        Map<String, String> carrier = new HashMap<>();
        W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, Map::put);
        return carrier.get("traceparent");
    }
}
