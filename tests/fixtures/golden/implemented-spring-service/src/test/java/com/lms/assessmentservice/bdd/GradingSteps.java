package com.lms.assessmentservice.bdd;

import static org.assertj.core.api.Assertions.assertThat;

import com.lms.assessmentservice.application.GradingService.GradeView;
import com.lms.assessmentservice.application.port.AuditLog;
import com.lms.assessmentservice.domain.grade.Grade;
import com.lms.assessmentservice.infrastructure.web.ApiExceptionHandler;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import java.math.BigDecimal;
import java.util.List;

/** features/grade_publication.feature */
public class GradingSteps {
    private final AssessmentWorld world;
    private String teacherId;
    private List<GradeView> studentView;

    public GradingSteps(AssessmentWorld world) {
        this.world = world;
    }

    @Given("an active institution {string}")
    public void anActiveInstitution(String institutionId) {
        assertThat(institutionId).isEqualTo(AssessmentWorld.INSTITUTION);
    }

    @Given("the teacher {string} is responsible for the course {string}")
    public void teacherResponsible(String teacher, String course) {
        teacherId = teacher;
        world.actor = AssessmentWorld.teacher(teacher);
        world.grading.teacherAssigned(AssessmentWorld.INSTITUTION, world.courseId(course), teacher);
    }

    @Given("the submission {string} of {string} has status {string}")
    public void submissionOf(String submissionId, String student, String status) {
        assertThat(status).isEqualTo("SUBMITTED");
        world.submitted(submissionId, student, "MATH-101");
    }

    @Given("the institution configured the grading scale {string}")
    public void configuredScale(String scale) {
        String[] bounds = scale.split("-");
        world.grading.institutionConfigured(AssessmentWorld.INSTITUTION, Integer.parseInt(bounds[0]), Integer.parseInt(bounds[1]));
    }

    @Given("the caller is the teacher {string}")
    public void callerIsTeacher(String teacher) {
        world.actor = AssessmentWorld.teacher(teacher);
    }

    @When("the teacher grades {string} with score {int} out of {int} and feedback")
    public void gradesWithFeedback(String submissionId, int score, int max) {
        grade(submissionId, score, "Good work, review exercise 3");
    }

    @When("the teacher grades {string} with score {int} out of {int}")
    public void grades(String submissionId, int score, int max) {
        grade(submissionId, score, null);
    }

    private void grade(String submissionId, int score, String feedback) {
        world.attempt(() -> world.lastResult = world.grading.grade(world.actor, AssessmentWorld.INSTITUTION, submissionId, BigDecimal.valueOf(score), feedback));
    }

    @Then("the grade should be recorded with status {string}")
    public void gradeRecorded(String status) {
        assertThat(world.lastError).isNull();
        assertThat(world.grades.findBySubmission(AssessmentWorld.INSTITUTION, "sub-1")).hasValueSatisfying(g -> {
            assertThat(g.status()).isEqualTo(Grade.Status.valueOf(status));
            assertThat(g.score()).isEqualByComparingTo("87");
            assertThat(g.feedback()).isNotBlank();
        });
    }

    @Given("the grade of {string} has status {string}")
    public void gradeWithStatus(String submissionId, String status) {
        world.grading.grade(AssessmentWorld.teacher(teacherId), AssessmentWorld.INSTITUTION, submissionId, BigDecimal.valueOf(80), null);
        if (Grade.Status.valueOf(status) == Grade.Status.PUBLISHED) {
            world.grading.publish(AssessmentWorld.teacher(teacherId), AssessmentWorld.INSTITUTION, submissionId);
        }
        world.events.published.clear();
        world.audit.entries.clear();
    }

    @When("the teacher publishes the grade of {string}")
    public void publishes(String submissionId) {
        world.attempt(() -> world.lastResult = world.grading.publish(AssessmentWorld.teacher(teacherId), AssessmentWorld.INSTITUTION, submissionId));
    }

    @When("the teacher corrects the grade of {string} to {int} because {string}")
    public void corrects(String submissionId, int score, String reason) {
        world.attempt(() -> world.lastResult =
            world.grading.correct(AssessmentWorld.teacher(teacherId), AssessmentWorld.INSTITUTION, submissionId, BigDecimal.valueOf(score), reason));
    }

    @Then("the grade status should become {string}")
    public void gradeStatus(String status) {
        assertThat(world.lastError).isNull();
        assertThat(world.grades.findBySubmission(AssessmentWorld.INSTITUTION, "sub-1").orElseThrow().status()).isEqualTo(Grade.Status.valueOf(status));
    }

    @Then("the change should be recorded in the audit log")
    public void auditRecorded() {
        assertThat(world.lastError).isNull();
        assertThat(world.audit.entries).anySatisfy(e -> {
            assertThat(e.action()).isIn("GRADE_PUBLISHED", "GRADE_CHANGED");
            assertThat(e.userId()).isEqualTo(teacherId);
            assertThat(e.outcome()).isEqualTo(AuditLog.Outcome.SUCCEEDED);
        });
    }

    @When("{string} requests their grades")
    public void requestsGrades(String student) {
        studentView = world.grading.publishedGradesOfStudent(AssessmentWorld.student(student), AssessmentWorld.INSTITUTION, student);
    }

    @Then("no grade should be returned")
    public void noGrade() {
        assertThat(studentView).isEmpty();
    }

    @Then("the published grade should be returned")
    public void publishedGradeReturned() {
        assertThat(studentView).singleElement().satisfies(g -> {
            assertThat(g.status()).isEqualTo(Grade.Status.PUBLISHED);
            assertThat(g.assignmentTitle()).isEqualTo("Limits worksheet");
        });
    }

    @Then("the request should fail with error {string}")
    public void failsWithError(String code) {
        assertThat(world.lastError).as("expected a rejected request").isNotNull();
        assertThat(world.lastError.code()).isEqualTo(code);
    }

    @Then("the request should be refused with reason {string}")
    public void refusedWithReason(String code) {
        failsWithError(code);
    }

    @Then("the request should be denied with HTTP {int} and error {string}")
    public void deniedWithError(int status, String code) {
        failsWithError(code);
        assertThat(ApiExceptionHandler.statusOf(world.lastError.kind()).value()).isEqualTo(status);
    }

    @Then("the {string} event is published")
    public void eventPublished(String type) {
        assertThat(world.events.ofType(type)).as("published %s events", type).isNotEmpty()
            .allSatisfy(p -> assertThat(p.tenantId()).isEqualTo(AssessmentWorld.INSTITUTION));
    }

    @Then("no {string} event is published")
    public void noEventPublished(String type) {
        assertThat(world.events.ofType(type)).as("published %s events", type).isEmpty();
    }
}
