package com.lms.assessmentservice.domain.grade;

import com.lms.assessmentservice.domain.shared.AggregateRoot;
import com.lms.assessmentservice.domain.shared.DomainEvent;
import com.lms.assessmentservice.domain.shared.DomainException;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The evaluation of a submission. A DRAFT grade is visible to the teacher only and can be changed
 * freely; once PUBLISHED the student sees it and changes are corrections with a reason, audited
 * (definitions §46: grade published, grade changed).
 */
public class Grade extends AggregateRoot {
    public enum Status { DRAFT, PUBLISHED }

    /** The graded work, as learned from learning AssignmentSubmitted. */
    public record Work(String submissionId, String assignmentId, String assignmentTitle, String courseId, String studentId) {}

    private final String id;
    private final String institutionId;
    private final Work work;
    private BigDecimal score;
    private GradingScale scale;
    private String feedback;
    private Status status;
    private String gradedBy;
    private Instant gradedAt;
    private Instant publishedAt;

    private Grade(String id, String institutionId, Work work, BigDecimal score, GradingScale scale, String feedback, Status status, String gradedBy,
                  Instant gradedAt, Instant publishedAt, long version) {
        this.id = Objects.requireNonNull(id);
        this.institutionId = Objects.requireNonNull(institutionId);
        this.work = Objects.requireNonNull(work);
        this.score = Objects.requireNonNull(score);
        this.scale = Objects.requireNonNull(scale);
        this.feedback = feedback == null ? "" : feedback;
        this.status = Objects.requireNonNull(status);
        this.gradedBy = Objects.requireNonNull(gradedBy);
        this.gradedAt = Objects.requireNonNull(gradedAt);
        this.publishedAt = publishedAt;
        this.version = version;
    }

    public static Grade draft(String id, String institutionId, Work work, BigDecimal score, GradingScale scale, String feedback, String teacherId, Instant now) {
        var grade = new Grade(id, institutionId, work, scale.validate(score), scale, checkFeedback(feedback), Status.DRAFT, teacherId, now, null, 0);
        grade.record(new DomainEvent("SubmissionGraded", id, grade.payload(Map.of("gradedBy", teacherId)), now));
        return grade;
    }

    public static Grade rehydrate(String id, String institutionId, Work work, BigDecimal score, GradingScale scale, String feedback, Status status,
                                  String gradedBy, Instant gradedAt, Instant publishedAt, long version) {
        return new Grade(id, institutionId, work, score, scale, feedback, status, gradedBy, gradedAt, publishedAt, version);
    }

    /** Re-grading a draft (e.g. after another look at the submission). */
    public void regrade(BigDecimal newScore, GradingScale currentScale, String newFeedback, String teacherId, Instant now) {
        if (status != Status.DRAFT) throw DomainException.conflict("GRADE_ALREADY_PUBLISHED", "A published grade can only be corrected with a reason");
        score = currentScale.validate(newScore);
        scale = currentScale;
        feedback = checkFeedback(newFeedback);
        gradedBy = teacherId;
        gradedAt = now;
        record(new DomainEvent("SubmissionGraded", id, payload(Map.of("gradedBy", teacherId)), now));
    }

    /** The student (and authorized guardians) can now see the grade. */
    public void publish(String teacherId, Instant now) {
        if (status == Status.PUBLISHED) throw DomainException.conflict("GRADE_ALREADY_PUBLISHED", "The grade is already published");
        status = Status.PUBLISHED;
        publishedAt = now;
        record(new DomainEvent("GradePublished", id, payload(Map.of("publishedBy", teacherId)), now));
    }

    /** Correcting a published grade requires a reason; the previous score stays in the event. */
    public void correct(BigDecimal newScore, String reason, String teacherId, Instant now) {
        if (status != Status.PUBLISHED) throw DomainException.conflict("GRADE_NOT_PUBLISHED", "Draft grades are changed by grading again");
        if (reason == null || reason.isBlank() || reason.length() > 500) {
            throw DomainException.invalid("CORRECTION_REASON_REQUIRED", "A correction needs a reason (max 500 characters)");
        }
        BigDecimal previous = score;
        score = scale.validate(newScore);
        gradedBy = teacherId;
        gradedAt = now;
        record(new DomainEvent("GradeChanged", id, payload(Map.of("previousScore", previous.toPlainString(), "reason", reason.trim(),
            "changedBy", teacherId)), now));
    }

    private static String checkFeedback(String feedback) {
        if (feedback != null && feedback.length() > 5000) throw DomainException.invalid("FEEDBACK_TOO_LONG", "Feedback is limited to 5000 characters");
        return feedback;
    }

    private Map<String, Object> payload(Map<String, Object> extra) {
        Map<String, Object> payload = new HashMap<>(Map.of("gradeId", id, "institutionId", institutionId, "submissionId", work.submissionId(),
            "assignmentId", work.assignmentId(), "assignmentTitle", work.assignmentTitle(), "courseId", work.courseId(), "studentId", work.studentId(),
            "score", score.toPlainString(), "scaleMin", scale.min(), "scaleMax", scale.max()));
        payload.putAll(extra);
        return payload;
    }

    public String id() { return id; }
    public String institutionId() { return institutionId; }
    public Work work() { return work; }
    public BigDecimal score() { return score; }
    public GradingScale scale() { return scale; }
    public String feedback() { return feedback; }
    public Status status() { return status; }
    public String gradedBy() { return gradedBy; }
    public Instant gradedAt() { return gradedAt; }
    public Instant publishedAt() { return publishedAt; }
}
