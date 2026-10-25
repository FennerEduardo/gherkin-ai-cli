package com.lms.assessmentservice.infrastructure.messaging;

import java.sql.Connection;
import java.util.Map;

/**
 * A consumed envelope plus the inbox transaction's connection: handlers write through it, so the
 * effect commits atomically with the ghk_inbox deduplication record.
 */
public record IncomingEvent(String eventId, String eventType, String tenantId, String correlationId, Map<String, Object> payload,
                            Connection connection) {
    public String text(String field) {
        Object value = payload.get(field);
        if (value == null) throw new IllegalArgumentException(eventType + " " + eventId + " has no " + field);
        return value.toString();
    }
}
