package com.lms.assessmentservice.infrastructure.messaging;

import com.lms.assessmentservice.application.GradingService;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.infrastructure.persistence.JdbcAssessmentAdapters;
import com.lms.assessmentservice.infrastructure.persistence.JdbcAuditLog;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.UUID;
import java.util.function.BiConsumer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

/** Projection handlers, run on the inbox transaction's connection. */
public final class AssessmentEventHandlers {
    private final ObjectMapper json;
    private final String producer;
    private final Clock clock;

    public AssessmentEventHandlers(ObjectMapper json, String producer, Clock clock) {
        this.json = json;
        this.producer = producer;
        this.clock = clock;
    }

    private EventHandler handler(String type, BiConsumer<GradingService, IncomingEvent> action) {
        return new EventHandler() {
            @Override public String eventType() { return type; }

            @Override public void handle(IncomingEvent event) {
                var jdbc = new JdbcTemplate(new SingleConnectionDataSource(event.connection(), true));
                action.accept(new GradingService(new JdbcAssessmentAdapters.Grades(jdbc), new JdbcAssessmentAdapters.Context(jdbc),
                    () -> UUID.randomUUID().toString(), new OutboxEventPublisher(jdbc, json, producer), new JdbcAuditLog(jdbc), clock), event);
            }
        };
    }

    /** institution InstitutionConfigured: the grading scale grades are validated against. */
    public EventHandler institutionConfigured() {
        return handler("InstitutionConfigured", (g, e) -> g.institutionConfigured(e.text("institutionId"),
            Integer.parseInt(e.text("gradingScaleMin")), Integer.parseInt(e.text("gradingScaleMax"))));
    }

    public EventHandler teacherAssigned() {
        return handler("TeacherAssignedToCourse", (g, e) -> g.teacherAssigned(e.text("institutionId"), e.text("courseId"), e.text("teacherId")));
    }

    public EventHandler assignmentSubmitted() {
        return handler("AssignmentSubmitted", (g, e) -> g.assignmentSubmitted(e.text("institutionId"), new Grade.Work(e.text("submissionId"),
            e.text("assignmentId"), e.text("assignmentTitle"), e.text("courseId"), e.text("studentId"))));
    }
}
