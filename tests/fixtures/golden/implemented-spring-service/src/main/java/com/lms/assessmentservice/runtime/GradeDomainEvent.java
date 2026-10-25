package com.lms.assessmentservice.runtime;

import java.time.Instant;
import java.util.Map;

public record GradeDomainEvent(GradeEventType type, String aggregateId, long version, Instant occurredOn, Map<String, Object> payload) {
}
