package com.lms.assessmentservice.support;

import com.lms.assessmentservice.application.port.AssessmentPorts;
import com.lms.assessmentservice.application.port.AuditLog;
import com.lms.assessmentservice.application.port.EventPublisher;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.grade.GradingScale;
import com.lms.assessmentservice.domain.shared.DomainEvent;
import com.lms.assessmentservice.domain.shared.DomainException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** In-memory ports storing copies, with the same optimistic-locking rule as the JDBC adapters. */
public final class InMemoryAdapters {
    private InMemoryAdapters() {}

    public static class Grades implements AssessmentPorts.Grades {
        private final Map<String, Grade> rows = new LinkedHashMap<>();

        private static Grade copy(Grade g) {
            return Grade.rehydrate(g.id(), g.institutionId(), g.work(), g.score(), g.scale(), g.feedback(), g.status(), g.gradedBy(), g.gradedAt(),
                g.publishedAt(), g.version());
        }

        @Override public Optional<Grade> findBySubmission(String inst, String submissionId) {
            return rows.values().stream().filter(g -> g.institutionId().equals(inst) && g.work().submissionId().equals(submissionId)).findFirst()
                .map(Grades::copy);
        }
        @Override public List<Grade> findByAssignment(String inst, String assignmentId) {
            return rows.values().stream().filter(g -> g.institutionId().equals(inst) && g.work().assignmentId().equals(assignmentId)).map(Grades::copy).toList();
        }
        @Override public List<Grade> findPublishedByStudent(String inst, String studentId) {
            return rows.values().stream().filter(g -> g.institutionId().equals(inst) && g.work().studentId().equals(studentId)
                && g.status() == Grade.Status.PUBLISHED).map(Grades::copy).toList();
        }
        @Override public void save(Grade g) {
            Grade existing = rows.get(g.id());
            long expected = g.version();
            if ((existing == null) != (expected == 0) || (existing != null && existing.version() != expected)) {
                throw DomainException.conflict("CONCURRENT_MODIFICATION", "stale version");
            }
            Grade stored = copy(g);
            stored.persistedAs(expected + 1);
            g.persistedAs(expected + 1);
            rows.put(g.id(), stored);
        }
    }

    public static class Context implements AssessmentPorts.Context {
        private final Map<String, GradingScale> scales = new HashMap<>();
        private final Map<String, String> teachers = new HashMap<>();
        private final Map<String, Grade.Work> works = new LinkedHashMap<>();

        @Override public GradingScale scale(String inst) { return scales.getOrDefault(inst, GradingScale.DEFAULT); }
        @Override public Optional<String> teacherOf(String inst, String courseId) { return Optional.ofNullable(teachers.get(inst + "|" + courseId)); }
        @Override public Optional<Grade.Work> work(String inst, String submissionId) { return Optional.ofNullable(works.get(inst + "|" + submissionId)); }
        @Override public Optional<String> courseOfAssignment(String inst, String assignmentId) {
            return works.entrySet().stream().filter(e -> e.getKey().startsWith(inst + "|") && e.getValue().assignmentId().equals(assignmentId))
                .map(e -> e.getValue().courseId()).findFirst();
        }
        @Override public void scale(String inst, GradingScale scale) { scales.put(inst, scale); }
        @Override public void assignTeacher(String inst, String courseId, String teacherId) { teachers.put(inst + "|" + courseId, teacherId); }
        @Override public void work(String inst, Grade.Work work) { works.putIfAbsent(inst + "|" + work.submissionId(), work); }
    }

    public static class RecordingEvents implements EventPublisher {
        public record Published(String tenantId, DomainEvent event) {}
        public final List<Published> published = new ArrayList<>();

        @Override public void publish(String tenantId, List<DomainEvent> events) { events.forEach(e -> published.add(new Published(tenantId, e))); }
        public List<Published> ofType(String type) { return published.stream().filter(p -> p.event().type().equals(type)).toList(); }
    }

    public static class RecordingAudit implements AuditLog {
        public final List<Entry> entries = new ArrayList<>();

        @Override public void record(Entry entry) { entries.add(entry); }
    }
}
