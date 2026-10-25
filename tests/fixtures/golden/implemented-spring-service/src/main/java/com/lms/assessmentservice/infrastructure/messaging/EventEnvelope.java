package com.lms.assessmentservice.infrastructure.messaging;

import java.time.Instant;
import java.util.Map;

/** Event envelope shared by every LMS service (definitions §19). */
public record EventEnvelope(String eventId, String eventType, int version, Instant occurredAt, String correlationId, String causationId,
                            String tenantId, String producer, Map<String, Object> payload) {}
