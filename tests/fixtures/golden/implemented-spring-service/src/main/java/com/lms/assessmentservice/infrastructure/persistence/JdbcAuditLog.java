package com.lms.assessmentservice.infrastructure.persistence;

import com.lms.assessmentservice.application.port.AuditLog;
import com.lms.assessmentservice.infrastructure.web.RequestContext;
import java.sql.Timestamp;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Writes in its own transaction (REQUIRES_NEW): a denied request still leaves its audit entry. */
public class JdbcAuditLog implements AuditLog {
    private final JdbcTemplate jdbc;

    public JdbcAuditLog(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(Entry e) {
        jdbc.update("INSERT INTO audit_log (occurred_at, tenant_id, user_id, action, resource, resource_id, outcome, correlation_id) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            Timestamp.from(e.occurredAt()), e.tenantId(), e.userId(), e.action(), e.resource(), e.resourceId(), e.outcome().name(),
            RequestContext.correlationId());
    }
}
