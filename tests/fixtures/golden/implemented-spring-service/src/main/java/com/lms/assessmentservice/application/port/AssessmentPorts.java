package com.lms.assessmentservice.application.port;

import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.grade.GradingScale;
import java.util.List;
import java.util.Optional;

/** Ports of the assessment context. Every lookup is scoped by institution (tenant). */
public final class AssessmentPorts {
    private AssessmentPorts() {}

    public interface Grades {
        Optional<Grade> findBySubmission(String institutionId, String submissionId);
        List<Grade> findByAssignment(String institutionId, String assignmentId);
        List<Grade> findPublishedByStudent(String institutionId, String studentId);
        void save(Grade grade);
    }

    /**
     * What assessment knows about other contexts, from their events (definitions §37): the grading
     * scale (institution), the course teachers (academic) and the submitted work (learning).
     */
    public interface Context {
        GradingScale scale(String institutionId);
        Optional<String> teacherOf(String institutionId, String courseId);
        Optional<Grade.Work> work(String institutionId, String submissionId);
        Optional<String> courseOfAssignment(String institutionId, String assignmentId);

        void scale(String institutionId, GradingScale scale);
        void assignTeacher(String institutionId, String courseId, String teacherId);
        void work(String institutionId, Grade.Work work);
    }
}
