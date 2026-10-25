package com.lms.assessmentservice.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.lms.assessmentservice.bdd.AssessmentWorld;
import java.math.BigDecimal;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class GradingApplicationTest {
    private final AssessmentWorld world = new AssessmentWorld();
    private static final String INST = AssessmentWorld.INSTITUTION;

    @BeforeEach
    void context() {
        world.grading.teacherAssigned(INST, world.courseId("MATH-101"), "teacher-7");
        world.submitted("sub-1", "s-1", "MATH-101");
        world.submitted("sub-2", "s-2", "MATH-101");
    }

    @Test
    void unknownSubmissionsCannotBeGraded() {
        assertThatThrownBy(() -> world.grading.grade(AssessmentWorld.teacher("teacher-7"), INST, "sub-x", BigDecimal.TEN, null))
            .hasFieldOrPropertyWithValue("code", "SUBMISSION_NOT_FOUND");
        assertThatThrownBy(() -> world.grading.publish(AssessmentWorld.teacher("teacher-7"), INST, "sub-1"))
            .hasFieldOrPropertyWithValue("code", "GRADE_NOT_FOUND");
    }

    @Test
    void theTeacherSeesAllGradesOfTheAssignmentTheStudentOnlyTheirPublishedOnes() {
        var teacher = AssessmentWorld.teacher("teacher-7");
        world.grading.grade(teacher, INST, "sub-1", BigDecimal.valueOf(90), null);
        world.grading.grade(teacher, INST, "sub-2", BigDecimal.valueOf(60), null);
        world.grading.publish(teacher, INST, "sub-1");
        assertThat(world.grading.gradesOfAssignment(teacher, INST, "asg-1")).hasSize(2);
        assertThat(world.grading.publishedGradesOfStudent(AssessmentWorld.student("s-1"), INST, "s-1")).hasSize(1);
        assertThat(world.grading.publishedGradesOfStudent(AssessmentWorld.student("s-2"), INST, "s-2")).isEmpty();
        assertThatThrownBy(() -> world.grading.publishedGradesOfStudent(AssessmentWorld.student("s-2"), INST, "s-1"))
            .hasFieldOrPropertyWithValue("code", "TENANT_ACCESS_DENIED");
        var coordinator = new Actor("dean", INST, Set.of("ACADEMIC_LEADER"), Set.of("GRADE_READ"));
        assertThat(world.grading.publishedGradesOfStudent(coordinator, INST, "s-1")).hasSize(1);
        assertThatThrownBy(() -> world.grading.gradesOfAssignment(AssessmentWorld.teacher("teacher-8"), INST, "asg-1"))
            .hasFieldOrPropertyWithValue("code", "COURSE_NOT_ASSIGNED");
    }

    @Test
    void anotherTenantSeesNothingAndDenialsAreAudited() {
        var foreign = new Actor("teacher-7", "inst-999", Set.of("TEACHER"), Set.of("GRADE_WRITE"));
        assertThatThrownBy(() -> world.grading.grade(foreign, INST, "sub-1", BigDecimal.TEN, null)).hasFieldOrPropertyWithValue("code", "COURSE_NOT_ASSIGNED");
        assertThatThrownBy(() -> world.grading.grade(AssessmentWorld.teacher("teacher-7"), "inst-999", "sub-1", BigDecimal.TEN, null))
            .hasFieldOrPropertyWithValue("code", "SUBMISSION_NOT_FOUND");
        assertThat(world.audit.entries).singleElement().satisfies(e -> assertThat(e.action()).isEqualTo("GRADE_SUBMISSION"));
    }

    @Test
    void aReassignedCourseMovesGradingToTheNewTeacher() {
        world.grading.teacherAssigned(INST, world.courseId("MATH-101"), "teacher-8");
        assertThatThrownBy(() -> world.grading.grade(AssessmentWorld.teacher("teacher-7"), INST, "sub-1", BigDecimal.TEN, null))
            .hasFieldOrPropertyWithValue("code", "COURSE_NOT_ASSIGNED");
        assertThat(world.grading.grade(AssessmentWorld.teacher("teacher-8"), INST, "sub-1", BigDecimal.TEN, null).score()).isEqualByComparingTo("10");
    }
}
