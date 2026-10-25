package com.lms.assessmentservice.infrastructure;

import com.lms.assessmentservice.application.GradingService;
import com.lms.assessmentservice.application.port.AssessmentPorts;
import com.lms.assessmentservice.application.port.AuditLog;
import com.lms.assessmentservice.application.port.EventPublisher;
import com.lms.assessmentservice.application.port.IdGenerator;
import com.lms.assessmentservice.infrastructure.messaging.AssessmentEventHandlers;
import com.lms.assessmentservice.infrastructure.messaging.EventHandler;
import com.lms.assessmentservice.infrastructure.messaging.MessagingProperties;
import com.lms.assessmentservice.infrastructure.messaging.OutboxEventPublisher;
import com.lms.assessmentservice.infrastructure.persistence.JdbcAssessmentAdapters;
import com.lms.assessmentservice.infrastructure.persistence.JdbcAuditLog;
import com.lms.assessmentservice.infrastructure.web.CorrelationIdFilter;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.UUID;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;

/** Composition root: adapters -> ports -> application services. */
@Configuration
@EnableConfigurationProperties(MessagingProperties.class)
public class AssessmentConfig {

    @Bean Clock clock() { return Clock.systemUTC(); }
    @Bean IdGenerator idGenerator() { return () -> UUID.randomUUID().toString(); }

    @Bean AssessmentPorts.Grades grades(JdbcTemplate jdbc) { return new JdbcAssessmentAdapters.Grades(jdbc); }
    @Bean AssessmentPorts.Context context(JdbcTemplate jdbc) { return new JdbcAssessmentAdapters.Context(jdbc); }
    @Bean AuditLog auditLog(JdbcTemplate jdbc) { return new JdbcAuditLog(jdbc); }

    @Bean EventPublisher eventPublisher(JdbcTemplate jdbc, ObjectMapper json, MessagingProperties messaging) {
        return new OutboxEventPublisher(jdbc, json, messaging.producer());
    }

    @Bean GradingService gradingService(AssessmentPorts.Grades grades, AssessmentPorts.Context context, IdGenerator ids, EventPublisher events,
                                        AuditLog audit, Clock clock) {
        return new GradingService(grades, context, ids, events, audit, clock);
    }

    @Bean AssessmentEventHandlers assessmentEventHandlers(ObjectMapper json, MessagingProperties messaging, Clock clock) {
        return new AssessmentEventHandlers(json, messaging.producer(), clock);
    }

    @Bean EventHandler institutionConfiguredHandler(AssessmentEventHandlers h) { return h.institutionConfigured(); }
    @Bean EventHandler teacherAssignedHandler(AssessmentEventHandlers h) { return h.teacherAssigned(); }
    @Bean EventHandler assignmentSubmittedHandler(AssessmentEventHandlers h) { return h.assignmentSubmitted(); }

    @Bean FilterRegistrationBean<CorrelationIdFilter> correlationIdFilter() {
        var registration = new FilterRegistrationBean<>(new CorrelationIdFilter());
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }
}
