package com.lms.assessmentservice.bdd;

import com.lms.assessmentservice.application.Actor;
import com.lms.assessmentservice.application.GradingService;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.shared.DomainException;
import com.lms.assessmentservice.support.InMemoryAdapters;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Set;
import java.util.UUID;

/** Scenario state shared by the step classes. */
public class AssessmentWorld {
    public static final String INSTITUTION = "inst-001";

    public final Clock clock = Clock.fixed(Instant.parse("2027-02-25T10:00:00Z"), ZoneOffset.UTC);
    public final InMemoryAdapters.Grades grades = new InMemoryAdapters.Grades();
    public final InMemoryAdapters.Context context = new InMemoryAdapters.Context();
    public final InMemoryAdapters.RecordingEvents events = new InMemoryAdapters.RecordingEvents();
    public final InMemoryAdapters.RecordingAudit audit = new InMemoryAdapters.RecordingAudit();
    public final GradingService grading = new GradingService(grades, context, () -> UUID.randomUUID().toString(), events, audit, clock);

    public Actor actor;
    public Object lastResult;
    public DomainException lastError;

    public void attempt(Runnable action) {
        lastError = null;
        try {
            action.run();
        } catch (DomainException e) {
            lastError = e;
        }
    }

    public static Actor teacher(String userId) {
        return new Actor(userId, INSTITUTION, Set.of("TEACHER"), Set.of("GRADE_WRITE", "GRADE_PUBLISH", "GRADE_READ"));
    }

    public static Actor student(String userId) {
        return new Actor(userId, INSTITUTION, Set.of("STUDENT"), Set.of("GRADE_READ_OWN"));
    }

    public String courseId(String code) { return "course-" + code; }

    /** A submission learned from learning's AssignmentSubmitted event. */
    public void submitted(String submissionId, String studentId, String course) {
        grading.assignmentSubmitted(INSTITUTION, new Grade.Work(submissionId, "asg-1", "Limits worksheet", courseId(course), studentId));
    }
}
