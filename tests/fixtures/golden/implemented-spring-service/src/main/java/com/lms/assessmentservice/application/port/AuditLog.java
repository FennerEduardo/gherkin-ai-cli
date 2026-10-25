package com.lms.assessmentservice.application.port;

import java.time.Instant;

/**
 * Append-only audit trail (definitions §46). Entries are written in their own transaction, so a
 * denied or failed action stays recorded even though the business transaction rolls back.
 */
public interface AuditLog {
    enum Outcome { SUCCEEDED, DENIED, FAILED }

    record Entry(String tenantId, String userId, String action, String resource, String resourceId, Outcome outcome, Instant occurredAt) {}

    void record(Entry entry);
}
