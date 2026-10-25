package com.lms.assessmentservice.application;

import com.lms.assessmentservice.application.port.AssessmentPorts;
import com.lms.assessmentservice.application.port.AuditLog;
import com.lms.assessmentservice.application.port.EventPublisher;
import com.lms.assessmentservice.application.port.IdGenerator;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.shared.DomainException;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import org.springframework.transaction.annotation.Transactional;

/** Feature: Grading and grade publication (features/grade_publication.feature). */
public class GradingService {
    public record GradeView(String gradeId, String submissionId, String assignmentId, String assignmentTitle, String courseId, String studentId,
                            BigDecimal score, int scaleMin, int scaleMax, String feedback, Grade.Status status, Instant gradedAt, Instant publishedAt) {
        static GradeView of(Grade g) {
            return new GradeView(g.id(), g.work().submissionId(), g.work().assignmentId(), g.work().assignmentTitle(), g.work().courseId(),
                g.work().studentId(), g.score(), g.scale().min(), g.scale().max(), g.feedback(), g.status(), g.gradedAt(), g.publishedAt());
        }
    }

    private final AssessmentPorts.Grades grades;
    private final AssessmentPorts.Context context;
    private final IdGenerator ids;
    private final EventPublisher events;
    private final AuditLog audit;
    private final Clock clock;

    public GradingService(AssessmentPorts.Grades grades, AssessmentPorts.Context context, IdGenerator ids, EventPublisher events, AuditLog audit,
                          Clock clock) {
        this.grades = grades;
        this.context = context;
        this.ids = ids;
        this.events = events;
        this.audit = audit;
        this.clock = clock;
    }

    /** Grades (or re-grades) a submission as a draft, on the institution's current grading scale. */
    @Transactional
    public GradeView grade(Actor actor, String institutionId, String submissionId, BigDecimal score, String feedback) {
        Instant now = clock.instant();
        var work = loadWork(institutionId, submissionId);
        requireTeacher(actor, institutionId, work.courseId(), "GRADE_SUBMISSION", submissionId, now);
        var scale = context.scale(institutionId);
        var grade = grades.findBySubmission(institutionId, submissionId)
            .map(existing -> { existing.regrade(score, scale, feedback, actor.userId(), now); return existing; })
            .orElseGet(() -> Grade.draft(ids.newId(), institutionId, work, score, scale, feedback, actor.userId(), now));
        grades.save(grade);
        events.publish(institutionId, grade.pullEvents());
        return GradeView.of(grade);
    }

    @Transactional
    public GradeView publish(Actor actor, String institutionId, String submissionId) {
        Instant now = clock.instant();
        var grade = loadGrade(institutionId, submissionId);
        requireTeacher(actor, institutionId, grade.work().courseId(), "PUBLISH_GRADE", submissionId, now);
        grade.publish(actor.userId(), now);
        grades.save(grade);
        events.publish(institutionId, grade.pullEvents());
        audit.record(new AuditLog.Entry(institutionId, actor.userId(), "GRADE_PUBLISHED", "grade", grade.id(), AuditLog.Outcome.SUCCEEDED, now));
        return GradeView.of(grade);
    }

    @Transactional
    public GradeView correct(Actor actor, String institutionId, String submissionId, BigDecimal score, String reason) {
        Instant now = clock.instant();
        var grade = loadGrade(institutionId, submissionId);
        requireTeacher(actor, institutionId, grade.work().courseId(), "CORRECT_GRADE", submissionId, now);
        grade.correct(score, reason, actor.userId(), now);
        grades.save(grade);
        events.publish(institutionId, grade.pullEvents());
        audit.record(new AuditLog.Entry(institutionId, actor.userId(), "GRADE_CHANGED", "grade", grade.id(), AuditLog.Outcome.SUCCEEDED, now));
        return GradeView.of(grade);
    }

    /** The course's teacher sees every grade of an assignment, drafts included. */
    @Transactional(readOnly = true)
    public List<GradeView> gradesOfAssignment(Actor actor, String institutionId, String assignmentId) {
        String courseId = context.courseOfAssignment(institutionId, assignmentId)
            .orElseThrow(() -> DomainException.notFound("ASSIGNMENT_NOT_FOUND", "No submissions known for assignment " + assignmentId));
        requireTeacher(actor, institutionId, courseId, "LIST_GRADES", assignmentId, clock.instant());
        return grades.findByAssignment(institutionId, assignmentId).stream().sorted(Comparator.comparing(Grade::gradedAt)).map(GradeView::of).toList();
    }

    /** A student sees only their published grades; staff with GRADE_READ see any student's. */
    @Transactional(readOnly = true)
    public List<GradeView> publishedGradesOfStudent(Actor actor, String institutionId, String studentId) {
        Actor.require(actor);
        boolean self = institutionId.equals(actor.tenant()) && actor.userId().equals(studentId);
        if (!self && !actor.can(institutionId, "GRADE_READ")) throw DomainException.forbidden("TENANT_ACCESS_DENIED", "Not allowed to read these grades");
        return grades.findPublishedByStudent(institutionId, studentId).stream()
            .sorted(Comparator.comparing(Grade::publishedAt)).map(GradeView::of).toList();
    }

    /** Projections fed by events. */
    @Transactional
    public void institutionConfigured(String institutionId, int scaleMin, int scaleMax) {
        context.scale(institutionId, new com.lms.assessmentservice.domain.grade.GradingScale(scaleMin, scaleMax));
    }

    @Transactional
    public void teacherAssigned(String institutionId, String courseId, String teacherId) {
        context.assignTeacher(institutionId, courseId, teacherId);
    }

    @Transactional
    public void assignmentSubmitted(String institutionId, Grade.Work work) {
        context.work(institutionId, work);
    }

    /** Relationship check (definitions §29): only the teacher assigned to the course grades its work. */
    private void requireTeacher(Actor actor, String institutionId, String courseId, String action, String resourceId, Instant now) {
        Actor.require(actor);
        boolean teaches = actor.can(institutionId, "GRADE_WRITE") && context.teacherOf(institutionId, courseId).map(actor.userId()::equals).orElse(false);
        if (!teaches) {
            audit.record(new AuditLog.Entry(institutionId, actor.userId(), action, "submission", resourceId, AuditLog.Outcome.DENIED, now));
            throw DomainException.forbidden("COURSE_NOT_ASSIGNED", "The course is not assigned to this teacher");
        }
    }

    private Grade.Work loadWork(String institutionId, String submissionId) {
        return context.work(institutionId, submissionId)
            .orElseThrow(() -> DomainException.notFound("SUBMISSION_NOT_FOUND", "No submission " + submissionId));
    }

    private Grade loadGrade(String institutionId, String submissionId) {
        return grades.findBySubmission(institutionId, submissionId)
            .orElseThrow(() -> DomainException.notFound("GRADE_NOT_FOUND", "The submission is not graded yet"));
    }
}
