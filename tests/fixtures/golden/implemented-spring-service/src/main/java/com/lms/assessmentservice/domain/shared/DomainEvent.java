package com.lms.assessmentservice.domain.shared;

import java.time.Instant;
import java.util.Map;

/** A business fact that already happened (definitions §17). Published through the outbox. */
public record DomainEvent(String type, String aggregateId, Map<String, Object> payload, Instant occurredAt) {
    public DomainEvent {
        payload = Map.copyOf(payload);
    }
}
