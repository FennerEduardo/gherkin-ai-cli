package com.lms.assessmentservice.infrastructure.persistence;

import com.lms.assessmentservice.application.port.AssessmentPorts;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.domain.grade.GradingScale;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;

/** JDBC adapters of the assessment ports. Every query filters by institution_id (tenant isolation). */
public final class JdbcAssessmentAdapters {
    private JdbcAssessmentAdapters() {}

    public static class Grades implements AssessmentPorts.Grades {
        private static final String COLUMNS = "id, institution_id, submission_id, assignment_id, assignment_title, course_id, student_id, score, "
            + "scale_min, scale_max, feedback, status, graded_by, graded_at, published_at, version";
        private final JdbcTemplate jdbc;

        public Grades(JdbcTemplate jdbc) { this.jdbc = jdbc; }

        @Override public Optional<Grade> findBySubmission(String inst, String submissionId) {
            return jdbc.query("SELECT " + COLUMNS + " FROM grades WHERE institution_id = ? AND submission_id = ?", this::map, inst, submissionId)
                .stream().findFirst();
        }
        @Override public List<Grade> findByAssignment(String inst, String assignmentId) {
            return jdbc.query("SELECT " + COLUMNS + " FROM grades WHERE institution_id = ? AND assignment_id = ?", this::map, inst, assignmentId);
        }
        @Override public List<Grade> findPublishedByStudent(String inst, String studentId) {
            return jdbc.query("SELECT " + COLUMNS + " FROM grades WHERE institution_id = ? AND student_id = ? AND status = 'PUBLISHED'", this::map,
                inst, studentId);
        }
        @Override public void save(Grade g) {
            var w = g.work();
            OptimisticSave.save(jdbc, g, "INSERT INTO grades (" + COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                new Object[] {g.id(), g.institutionId(), w.submissionId(), w.assignmentId(), w.assignmentTitle(), w.courseId(), w.studentId(), g.score(),
                    g.scale().min(), g.scale().max(), g.feedback(), g.status().name(), g.gradedBy(), Timestamp.from(g.gradedAt()), ts(g)},
                "UPDATE grades SET score = ?, scale_min = ?, scale_max = ?, feedback = ?, status = ?, graded_by = ?, graded_at = ?, published_at = ?, "
                    + "version = ? WHERE id = ? AND version = ?",
                OptimisticSave.withVersion(g, g.id(), g.score(), g.scale().min(), g.scale().max(), g.feedback(), g.status().name(), g.gradedBy(),
                    Timestamp.from(g.gradedAt()), ts(g)));
        }
        private static Timestamp ts(Grade g) { return g.publishedAt() == null ? null : Timestamp.from(g.publishedAt()); }

        private Grade map(ResultSet rs, int row) throws SQLException {
            var work = new Grade.Work(rs.getString("submission_id"), rs.getString("assignment_id"), rs.getString("assignment_title"),
                rs.getString("course_id"), rs.getString("student_id"));
            Timestamp published = rs.getTimestamp("published_at");
            return Grade.rehydrate(rs.getString("id"), rs.getString("institution_id"), work, rs.getBigDecimal("score"),
                new GradingScale(rs.getInt("scale_min"), rs.getInt("scale_max")), rs.getString("feedback"), Grade.Status.valueOf(rs.getString("status")),
                rs.getString("graded_by"), rs.getTimestamp("graded_at").toInstant(), published == null ? null : published.toInstant(), rs.getLong("version"));
        }
    }

    public static class Context implements AssessmentPorts.Context {
        private final JdbcTemplate jdbc;

        public Context(JdbcTemplate jdbc) { this.jdbc = jdbc; }

        @Override public GradingScale scale(String inst) {
            return jdbc.query("SELECT scale_min, scale_max FROM grading_scales WHERE institution_id = ?",
                (rs, n) -> new GradingScale(rs.getInt(1), rs.getInt(2)), inst).stream().findFirst().orElse(GradingScale.DEFAULT);
        }
        @Override public Optional<String> teacherOf(String inst, String courseId) {
            return jdbc.queryForList("SELECT teacher_id FROM course_teachers WHERE institution_id = ? AND course_id = ?", String.class, inst, courseId)
                .stream().findFirst();
        }
        @Override public Optional<Grade.Work> work(String inst, String submissionId) {
            return jdbc.query("SELECT submission_id, assignment_id, assignment_title, course_id, student_id FROM submitted_work "
                    + "WHERE institution_id = ? AND submission_id = ?",
                (rs, n) -> new Grade.Work(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)), inst, submissionId)
                .stream().findFirst();
        }
        @Override public Optional<String> courseOfAssignment(String inst, String assignmentId) {
            return jdbc.queryForList("SELECT course_id FROM submitted_work WHERE institution_id = ? AND assignment_id = ? LIMIT 1", String.class,
                inst, assignmentId).stream().findFirst();
        }
        @Override public void scale(String inst, GradingScale scale) {
            jdbc.update("INSERT INTO grading_scales (institution_id, scale_min, scale_max) VALUES (?, ?, ?) "
                + "ON CONFLICT (institution_id) DO UPDATE SET scale_min = EXCLUDED.scale_min, scale_max = EXCLUDED.scale_max", inst, scale.min(), scale.max());
        }
        @Override public void assignTeacher(String inst, String courseId, String teacherId) {
            jdbc.update("INSERT INTO course_teachers (institution_id, course_id, teacher_id) VALUES (?, ?, ?) "
                + "ON CONFLICT (institution_id, course_id) DO UPDATE SET teacher_id = EXCLUDED.teacher_id", inst, courseId, teacherId);
        }
        @Override public void work(String inst, Grade.Work w) {
            jdbc.update("INSERT INTO submitted_work (institution_id, submission_id, assignment_id, assignment_title, course_id, student_id) "
                + "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", inst, w.submissionId(), w.assignmentId(), w.assignmentTitle(), w.courseId(), w.studentId());
        }
    }
}
