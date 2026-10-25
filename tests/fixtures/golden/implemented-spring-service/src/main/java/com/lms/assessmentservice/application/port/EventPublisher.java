package com.lms.assessmentservice.application.port;

import com.lms.assessmentservice.domain.shared.DomainEvent;
import java.util.List;

/**
 * Publishes domain events through the transactional outbox: the events commit or roll back with
 * the business change (definitions §42).
 */
public interface EventPublisher {
    /** Tenant for events that do not belong to an institution (accounts, logins). */
    String PLATFORM_TENANT = "platform";

    void publish(String tenantId, List<DomainEvent> events);
}
